import type { ReadContext, Reader } from '../../core/reader.js';
import { CorruptFileError } from '../../core/errors.js';

const BLOCK = 512;
const PAX_TYPES = new Set([0x78, 0x67]);

export const reader: Reader = {
  id: 'tar',
  mimeTypes: ['application/x-tar'],
  detect(bytes) {
    if (bytes.length < BLOCK) return 0;
    return decodeAscii(bytes.subarray(257, 262)) === 'ustar' ? 0.9 : 0;
  },
  async read(ctx: ReadContext): Promise<void> {
    const bytes = ctx.bytes;
    let offset = 0;
    let pendingPath: string | undefined;
    let pendingSize: number | undefined;
    let globalPath: string | undefined;
    let globalSize: number | undefined;
    let readAny = false;
    let terminatorSeen = false;
    let entrySeen = false;

    while (offset + BLOCK <= bytes.length) {
      if (hasResourceTruncation(ctx)) return;
      ctx.budget.tick();
      const header = bytes.subarray(offset, offset + BLOCK);
      if (isZeroBlock(header, ctx)) {
        terminatorSeen = true;
        break;
      }
      if (!ctx.budget.addEntries(1)) return;
      const storedChecksum = parseNumber(header.subarray(148, 156), ctx);
      if (storedChecksum === null || checksum(header, ctx) !== storedChecksum)
        throw new CorruptFileError('The tar header checksum is invalid.');

      const rawName = readText(header.subarray(0, 100), ctx);
      const prefix = readText(header.subarray(345, 500), ctx);
      const type = header[156] ?? 0;
      const rawSize = parseNumber(header.subarray(124, 136), ctx);
      if (rawSize === null) throw new CorruptFileError();
      const dataStart = offset + BLOCK;
      const extendedHeader = PAX_TYPES.has(type) || type === 0x4c;
      const effectiveSize = extendedHeader ? rawSize : (pendingSize ?? globalSize ?? rawSize);
      const dataEnd = dataStart + effectiveSize;
      if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.length)
        throw new CorruptFileError('The tar entry exceeds the available archive bytes.');
      entrySeen = true;

      if (PAX_TYPES.has(type) || type === 0x4c) {
        if (effectiveSize > ctx.budget.limits.inputBytes || !ctx.budget.checkOutputChars(effectiveSize))
          return;
        if (!ctx.budget.addUncompressed(effectiveSize)) return;
        const metadata = bytes.subarray(dataStart, dataEnd);
        readAny = true;
        if (type === 0x4c) {
          pendingPath = readText(metadata, ctx);
        } else {
          const parsed = parsePax(metadata, ctx);
          if (type === 0x67) {
            globalPath = parsed.path ?? globalPath;
            globalSize = parsed.size ?? globalSize;
          } else {
            pendingPath = parsed.path ?? pendingPath;
            pendingSize = parsed.size ?? pendingSize;
          }
        }
        offset = paddedEnd(dataEnd, bytes.length);
        continue;
      }

      const joined = prefix ? `${prefix}/${rawName}` : rawName;
      const name = cleanName(pendingPath ?? globalPath ?? joined, ctx);
      const size = pendingSize ?? globalSize ?? rawSize;
      pendingPath = undefined;
      pendingSize = undefined;
      if (size !== effectiveSize) {
        const correctedEnd = dataStart + size;
        if (!Number.isSafeInteger(correctedEnd) || correctedEnd > bytes.length)
          throw new CorruptFileError('The tar entry exceeds the available archive bytes.');
      }
      const entryEnd = dataStart + size;
      const padded = paddedEnd(entryEnd, bytes.length);
      const directory = type === 0x35 || name.endsWith('/');
      const regular = type === 0 || type === 0x30 || type === 0x37;
      const link = type === 0x32 || type === 0x31;

      if (ctx.options.children === 'skip') {
        // Parse headers to advance safely, but do not expose skipped children.
      } else if (directory) {
        ctx.out.addChild({ path: childPath(ctx, name), name, status: 'skipped', sizeBytes: size });
      } else if (!directory && !regular && !link) {
        ctx.out.addChild({ path: childPath(ctx, name), name, status: 'skipped', sizeBytes: size });
      } else if (!directory && link) {
        ctx.out.addChild({ path: childPath(ctx, name), name, status: 'listed', sizeBytes: size });
      } else if (!directory && regular && ctx.options.children === 'list') {
        ctx.out.addChild({ path: childPath(ctx, name), name, status: 'listed', sizeBytes: size });
      } else if (!directory && regular) {
        if (ctx.options.children === 'extract' && !preflightChild(ctx)) {
          ctx.out.addChild({ path: childPath(ctx, name), name, status: 'listed', sizeBytes: size });
          offset = padded;
          continue;
        }
        if (size > 0) {
          if (!ctx.budget.addUncompressed(size)) return;
          await ctx.extractChild(name, bytes.subarray(dataStart, entryEnd));
          readAny = true;
        } else {
          await ctx.extractChild(name, new Uint8Array());
          readAny = true;
        }
        if (hasOutputTruncation(ctx)) return;
      }
      offset = padded;
    }

    if (offset > 0 && offset < bytes.length && !terminatorSeen && offset + BLOCK > bytes.length) {
      throw new CorruptFileError('The tar archive ends with a partial header.');
    }
    if (!readAny && !terminatorSeen && !entrySeen) throw new CorruptFileError();
  },
};

function checksum(header: Uint8Array, ctx: ReadContext): number {
  let sum = 0;
  for (let index = 0; index < header.length; index++) {
    ctx.budget.tick();
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

function parseNumber(field: Uint8Array, ctx: ReadContext): number | null {
  if (field.length === 0) return null;
  let start = 0;
  while (start < field.length && (field[start] === 0x20 || field[start] === 0x00)) {
    ctx.budget.tick();
    start++;
  }
  if (start === field.length) return 0;
  // POSIX base-256 numbers are supported only when their sign bit is clear.
  if ((field[start]! & 0x80) !== 0) {
    if ((field[start]! & 0x40) !== 0) return null;
    let value = field[start]! & 0x7f;
    for (let index = start + 1; index < field.length; index++) {
      ctx.budget.tick();
      value = value * 256 + field[index]!;
      if (!Number.isSafeInteger(value)) return null;
    }
    return value;
  }
  let value = 0;
  let sawDigit = false;
  for (let index = start; index < field.length; index++) {
    ctx.budget.tick();
    const byte = field[index]!;
    if (byte === 0 || byte === 0x20) break;
    if (byte < 0x30 || byte > 0x37) return null;
    value = value * 8 + byte - 0x30;
    if (!Number.isSafeInteger(value)) return null;
    sawDigit = true;
  }
  return sawDigit ? value : 0;
}

function parsePax(bytes: Uint8Array, ctx: ReadContext): { path?: string; size?: number } {
  const values = new Map<string, string>();
  let cursor = 0;
  while (cursor < bytes.length) {
    ctx.budget.tick();
    const recordStart = cursor;
    let length = 0;
    let digits = 0;
    while (cursor < bytes.length && bytes[cursor] !== 0x20) {
      ctx.budget.tick();
      const byte = bytes[cursor++]!;
      if (byte < 0x30 || byte > 0x39) throw new CorruptFileError('The PAX metadata is invalid.');
      length = length * 10 + byte - 0x30;
      digits++;
      if (!Number.isSafeInteger(length) || length > bytes.length - recordStart)
        throw new CorruptFileError('The PAX metadata exceeds its entry bounds.');
    }
    if (digits === 0 || cursor >= bytes.length) throw new CorruptFileError('The PAX metadata is invalid.');
    cursor++;
    const end = recordStart + length;
    if (end > bytes.length || end <= cursor)
      throw new CorruptFileError('The PAX metadata exceeds its entry bounds.');
    if (bytes[end - 1] !== 0x0a)
      throw new CorruptFileError('The PAX metadata record is missing its newline.');
    const line = new TextDecoder().decode(bytes.subarray(cursor, end - 1));
    let equals = -1;
    for (let index = 0; index < line.length; index++) {
      ctx.budget.tick();
      if (line[index] === '=') {
        equals = index;
        break;
      }
    }
    if (equals > 0) values.set(line.slice(0, equals), line.slice(equals + 1));
    cursor = end;
  }
  const result: { path?: string; size?: number } = {};
  const path = values.get('path');
  if (path !== undefined) result.path = path;
  const sizeText = values.get('size');
  if (sizeText !== undefined) {
    const size = parseDecimal(sizeText, ctx);
    if (size === null) throw new CorruptFileError('The PAX size is invalid.');
    result.size = size;
  }
  return result;
}

function readText(bytes: Uint8Array, ctx: ReadContext): string {
  let end = bytes.length;
  for (let index = 0; index < bytes.length; index++) {
    ctx.budget.tick();
    if (bytes[index] === 0) {
      end = index;
      break;
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
}

function decodeAscii(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return value;
}

function isZeroBlock(bytes: Uint8Array, ctx: ReadContext): boolean {
  for (const byte of bytes) {
    ctx.budget.tick();
    if (byte !== 0) return false;
  }
  return true;
}

function paddedEnd(end: number, archiveLength: number): number {
  const padded = end + ((BLOCK - (end % BLOCK)) % BLOCK);
  if (!Number.isSafeInteger(padded) || padded > archiveLength)
    throw new CorruptFileError('The tar entry exceeds the available archive bytes.');
  return padded;
}

function parseDecimal(value: string, ctx: ReadContext): number | null {
  if (value.length === 0) return null;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return null;
    if (index === 0 && value.length > 1 && code === 0x30) return null;
    result = result * 10 + code - 0x30;
    if (!Number.isSafeInteger(result)) return null;
  }
  return result;
}

function cleanName(input: string, ctx: ReadContext): string {
  let normalized = '';
  for (let index = 0; index < input.length; index++) {
    ctx.budget.tick();
    const character = input[index]!;
    const code = input.charCodeAt(index);
    normalized += character === '\\' ? '/' : code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? '�' : character;
  }
  if (
    normalized.length >= 2 &&
    ((normalized.charCodeAt(0) >= 0x41 && normalized.charCodeAt(0) <= 0x5a) ||
      (normalized.charCodeAt(0) >= 0x61 && normalized.charCodeAt(0) <= 0x7a)) &&
    normalized.charCodeAt(1) === 0x3a
  ) {
    normalized = normalized.slice(2);
  }
  const trailingSlash = normalized.endsWith('/');
  const segments: string[] = [];
  let start = 0;
  for (let index = 0; index <= normalized.length; index++) {
    ctx.budget.tick();
    if (index < normalized.length && normalized[index] !== '/') continue;
    const segment = normalized.slice(start, index);
    if (segment && segment !== '.' && segment !== '..') segments.push(segment);
    start = index + 1;
  }
  let cleaned = '';
  for (const segment of segments) {
    ctx.budget.tick();
    cleaned += cleaned ? `/${segment}` : segment;
  }
  return trailingSlash && cleaned ? `${cleaned}/` : cleaned || 'entry';
}

function childPath(ctx: ReadContext, name: string): string {
  return ctx.path ? `${ctx.path}/${name}` : name;
}

function preflightChild(ctx: ReadContext): boolean {
  const canRead = ctx.budget.enterDepth('child');
  ctx.budget.exitDepth('child');
  return canRead;
}

function hasResourceTruncation(ctx: ReadContext): boolean {
  if (!ctx.budget.truncated) return false;
  return ctx.budget.warnings.warnings.some((warning) => warning.code === 'TRUNCATED');
}

function hasOutputTruncation(ctx: ReadContext): boolean {
  return ctx.budget.outputChars > ctx.budget.limits.outputChars;
}

import { Gunzip } from 'fflate';
import type { ReadContext, Reader } from '../../core/reader.js';
import { CorruptFileError, DocsluiceError } from '../../core/errors.js';

/**
 * Compressed bytes per push. DEFLATE expands at most about 1,032 times, so one push yields at most
 * about 4 MB before the next uncompressed-byte and ratio check.
 */
const CHUNK_SIZE = 4096;
/** CRC bytes per budget tick. */
const CRC_TICK = 65_536;
const FEXTRA = 0x04;
const FNAME = 0x08;
const FCOMMENT = 0x10;
const FHCRC = 0x02;
const RESERVED = 0xe0;
const MAX_DISPLAY_NAME_BYTES = 4096;
const CRC_TABLE = makeCrcTable();

export const gzipReader: Reader = {
  id: 'gzip',
  mimeTypes: ['application/gzip', 'application/x-gzip'],
  detect(bytes) {
    return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? 1 : 0;
  },
  async read(ctx: ReadContext): Promise<void> {
    if (hasResourceTruncation(ctx)) return;
    const bytes = ctx.bytes;
    const header = inspectHeader(bytes, ctx);
    const fallback = ctx.filename?.replace(/\.gz$/i, '') || 'content';
    const name = cleanName(header.name || fallback, ctx);

    if (ctx.options.children === 'skip') return;
    if (ctx.options.children === 'list') {
      if (!ctx.budget.addEntries(1)) return;
      ctx.out.addChild({
        path: ctx.path ? `${ctx.path}/${name}` : name,
        name,
        status: 'listed',
        mimeType: 'application/octet-stream',
      });
      return;
    }
    if (!ctx.budget.addEntries(1)) return;
    if (!preflightChild(ctx)) {
      ctx.out.addChild({
        path: ctx.path ? `${ctx.path}/${name}` : name,
        name,
        status: 'listed',
      });
      return;
    }

    const chunks: Uint8Array[] = [];
    let outputSize = 0;
    let finished = false;
    let compressedFed = 0;
    let memberCompressedStart = 0;
    let memberCrc = 0xffffffff;
    let memberSize = 0;
    let stoppedByBudget = false;
    let outputStopped = false;
    let failure: unknown;

    const gunzip = new Gunzip((chunk, final) => {
      if (final) finished = true;
      ctx.budget.tick();
      if (failure || outputStopped || chunk.length === 0) return;
      try {
        if (!ctx.budget.addUncompressed(chunk.length)) {
          stoppedByBudget = true;
          outputStopped = true;
          return;
        }
        outputSize += chunk.length;
        memberSize += chunk.length;
        memberCrc = updateCrc(memberCrc, chunk, ctx);
        const compressedForMember = Math.max(0, compressedFed - memberCompressedStart);
        ctx.budget.checkRatio(compressedForMember, memberSize);
        chunks.push(chunk.slice());
      } catch (error) {
        failure = error;
        outputStopped = true;
      }
    });
    gunzip.onmember = (offset) => {
      ctx.budget.tick();
      if (offset > 0) {
        verifyTrailer(bytes, offset - 8, memberCrc, memberSize);
        ctx.budget.checkRatio(offset - memberCompressedStart, memberSize);
        inspectHeader(bytes.subarray(offset), ctx);
        if (!ctx.budget.addEntries(1)) {
          stoppedByBudget = true;
          outputStopped = true;
          return;
        }
      }
      memberCompressedStart = offset;
      memberCrc = 0xffffffff;
      memberSize = 0;
    };

    try {
      if (bytes.length <= header.end) throw new CorruptFileError();
      // Chunks go in as non-final pushes, then one empty final push: fflate only reports the next
      // member (and its boundary) when the stream is not yet marked final.
      for (let offset = 0; offset < bytes.length && !outputStopped; offset += CHUNK_SIZE) {
        ctx.budget.tick();
        const end = Math.min(offset + CHUNK_SIZE, bytes.length);
        compressedFed = end;
        gunzip.push(bytes.subarray(offset, end), false);
      }
      if (!outputStopped) gunzip.push(new Uint8Array(0), true);
    } catch (error) {
      if (error instanceof DocsluiceError) throw error;
      if (failure instanceof DocsluiceError) throw failure;
      throw new CorruptFileError('The gzip stream is invalid.', { cause: error });
    }
    if (failure instanceof DocsluiceError) throw failure;
    if (stoppedByBudget) return;
    if (outputStopped || !finished) throw new CorruptFileError('The gzip stream is invalid.');
    verifyTrailer(bytes, bytes.length - 8, memberCrc, memberSize);
    ctx.budget.checkRatio(bytes.length - memberCompressedStart, memberSize);

    const output = new Uint8Array(outputSize);
    let offset = 0;
    for (const chunk of chunks) {
      ctx.budget.tick();
      output.set(chunk, offset);
      offset += chunk.length;
    }
    await ctx.extractChild(name, output);
  },
};

interface HeaderInfo {
  end: number;
  name?: string;
}

/** Read and bound optional fields; fflate inflates DEFLATE while this reader checks FHCRC and trailers. */
function inspectHeader(bytes: Uint8Array, ctx: ReadContext): HeaderInfo {
  if (bytes.length < 10 || bytes[0] !== 0x1f || bytes[1] !== 0x8b || bytes[2] !== 8)
    throw new CorruptFileError();
  const flags = bytes[3]!;
  if ((flags & RESERVED) !== 0) throw new CorruptFileError();
  let cursor = 10;
  if ((flags & FEXTRA) !== 0) {
    if (cursor + 2 > bytes.length) throw new CorruptFileError();
    const length = bytes[cursor]! | (bytes[cursor + 1]! << 8);
    cursor += 2;
    if (length > bytes.length - cursor) throw new CorruptFileError();
    cursor += length;
  }
  let name: string | undefined;
  if ((flags & FNAME) !== 0) {
    const start = cursor;
    while (cursor < bytes.length && bytes[cursor] !== 0) {
      ctx.budget.tick();
      cursor++;
    }
    if (cursor >= bytes.length) throw new CorruptFileError();
    if (cursor - start <= MAX_DISPLAY_NAME_BYTES) {
      name = new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes.subarray(start, cursor));
    } else {
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'The GZIP original name exceeded the supported metadata length and was ignored.',
      });
    }
    cursor++;
  }
  if ((flags & FCOMMENT) !== 0) {
    while (cursor < bytes.length && bytes[cursor] !== 0) {
      ctx.budget.tick();
      cursor++;
    }
    if (cursor >= bytes.length) throw new CorruptFileError();
    cursor++;
  }
  if ((flags & FHCRC) !== 0) {
    if (cursor + 2 > bytes.length) throw new CorruptFileError();
    if ((crc32(bytes.subarray(0, cursor), ctx) & 0xffff) !== (bytes[cursor]! | (bytes[cursor + 1]! << 8))) {
      throw new CorruptFileError('The gzip header checksum is invalid.');
    }
    cursor += 2;
  }
  return { end: cursor, name };
}

function verifyTrailer(bytes: Uint8Array, offset: number, crc: number, size: number): void {
  if (offset < 0 || offset + 8 > bytes.length) throw new CorruptFileError('The gzip trailer is missing.');
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
  if (view.getUint32(0, true) !== (crc ^ 0xffffffff) >>> 0 || view.getUint32(4, true) !== size >>> 0) {
    throw new CorruptFileError('The gzip trailer checksum is invalid.');
  }
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

function updateCrc(previous: number, bytes: Uint8Array, ctx: ReadContext): number {
  let crc = previous;
  for (let index = 0; index < bytes.length; index++) {
    if (index % CRC_TICK === 0) ctx.budget.tick();
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function crc32(bytes: Uint8Array, ctx: ReadContext): number {
  return updateCrc(0xffffffff, bytes, ctx) ^ 0xffffffff;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value++) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit++) {
      remainder = (remainder & 1) !== 0 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[value] = remainder >>> 0;
  }
  return table;
}

function cleanName(value: string, ctx: ReadContext): string {
  let normalized = '';
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    const character = value[index]!;
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
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index <= normalized.length; index++) {
    ctx.budget.tick();
    if (index < normalized.length && normalized[index] !== '/') continue;
    const part = normalized.slice(start, index);
    if (part && part !== '.' && part !== '..') parts.push(part);
    start = index + 1;
  }
  return parts.join('/') || 'content';
}

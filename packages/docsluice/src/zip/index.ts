import { Inflate } from 'fflate';
import type { Budget } from '../core/budget.js';
import { CorruptFileError, DocsluiceError } from '../core/errors.js';

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const UTF8_FLAG = 1 << 11;
const ENCRYPTED_FLAG = 1;
const DATA_DESCRIPTOR_FLAG = 1 << 3;
const ZIP64_EXTRA_ID = 0x0001;
const EOCD_MIN_SIZE = 22;
const MAX_EOCD_SEARCH = EOCD_MIN_SIZE + 0xffff;
const SIZE_LIE_SLACK = 64 * 1024;
const INFLATE_INPUT_CHUNK = 63;

/** A file listed in the central directory. Names are display-safe plain strings. */
export interface ZipEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly compressionMethod: number;
  readonly isEncrypted: boolean;
  readonly isUnreadable: boolean;
}

/** A bounded archive index. Entries remain in central-directory order. */
export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  read(entry: ZipEntry): Promise<Uint8Array | null>;
}

interface DirectoryRecord {
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  disk: number;
}

interface EntryData {
  dataStart: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  crc32: number;
  encrypted: boolean;
  unreadable: boolean;
}

interface LocalRange {
  start: number;
  end: number;
  data: EntryData;
}

const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const CRC_TABLE = makeCrcTable();

/** Index ZIP central-directory records without reading entry payloads. */
export function openZip(bytes: Uint8Array, budget: Budget): ZipArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  budget.tick();
  const eocd = findEocd(view, budget);
  const directory = readDirectoryBounds(view, eocd);

  // This check precedes all work over central-directory entries (SEC-2).
  if (!budget.addEntries(directory.entryCount)) return makeArchive([], new Map(), bytes, budget);

  const records = parseDirectory(view, directory, budget);
  const entries: ZipEntry[] = [];
  const internal = new Map<ZipEntry, EntryData>();
  const names = new Map<string, ZipEntry[]>();
  const ranges: LocalRange[] = [];

  for (const record of records) {
    budget.tick();
    const encrypted = (record.flags & ENCRYPTED_FLAG) !== 0;
    const supported = record.method === 0 || record.method === 8;
    const local = inspectLocalHeader(view, record, directory.start, budget);
    const data: EntryData = {
      dataStart: local?.dataStart ?? 0,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      method: record.method,
      crc32: record.crc32,
      encrypted,
      unreadable: encrypted || !supported || local === null,
    };
    if (local !== null) ranges.push({ start: record.localOffset, end: local.rangeEnd, data });
    const entry: ZipEntry = Object.freeze({
      name: cleanName(decodeName(record.nameBytes, (record.flags & UTF8_FLAG) !== 0, budget), budget),
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      compressionMethod: record.method,
      isEncrypted: encrypted,
      isUnreadable: data.unreadable,
    });
    entries.push(entry);
    internal.set(entry, data);
    const byName = names.get(entry.name) ?? [];
    byName.push(entry);
    names.set(entry.name, byName);
    if (data.unreadable) warnUnreadable(budget);
  }

  detectOverlaps(ranges, budget);
  // Entries are immutable snapshots, so rebuild those affected by overlap.
  const finalized: ZipEntry[] = [];
  for (const entry of entries) {
    budget.tick();
    const data = internal.get(entry)!;
    if (entry.isUnreadable === data.unreadable) {
      finalized.push(entry);
      continue;
    }
    const replacement = Object.freeze({ ...entry, isUnreadable: data.unreadable });
    internal.set(replacement, data);
    internal.delete(entry);
    const byName = names.get(entry.name)!;
    for (let index = 0; index < byName.length; index += 1) {
      budget.tick();
      if (byName[index] === entry) {
        byName[index] = replacement;
        break;
      }
    }
    finalized.push(replacement);
  }

  return makeArchive(finalized, names, bytes, budget, internal);
}

function makeArchive(
  entries: ZipEntry[],
  names: Map<string, ZipEntry[]>,
  bytes: Uint8Array,
  budget: Budget,
  internal: Map<ZipEntry, EntryData> = new Map(),
): ZipArchive {
  return {
    entries: Object.freeze(entries),
    async read(entry: ZipEntry): Promise<Uint8Array | null> {
      await Promise.resolve();
      budget.tick();
      const candidates = names.get(entry.name);
      const data = internal.get(entry);
      let knownEntry = false;
      if (candidates) {
        for (const candidate of candidates) {
          budget.tick();
          if (candidate === entry) {
            knownEntry = true;
            break;
          }
        }
      }
      if (!data || !knownEntry || data.unreadable) return null;

      const compressed = bytes.subarray(data.dataStart, data.dataStart + data.compressedSize);
      const output: Uint8Array[] = [];
      let outputSize = 0;
      let compressedFed = 0;
      let actualCrc32 = 0;
      let stopped = false;
      let stoppedByBudget = false;
      let badStream = false;
      let reportedUnreadable = false;
      const reportUnreadable = (): void => {
        if (reportedUnreadable) return;
        reportedUnreadable = true;
        warnUnreadable(budget);
      };

      const ondata = (chunk: Uint8Array): void => {
        budget.tick();
        if (chunk.length === 0 || stopped) return;
        outputSize += chunk.length;
        const withinSharedBudget = budget.addUncompressed(chunk.length);
        if (!withinSharedBudget) {
          stopped = true;
          stoppedByBudget = true;
          return;
        }
        budget.checkRatio(compressedFed, outputSize);
        if (outputSize > data.uncompressedSize && outputSize - data.uncompressedSize > SIZE_LIE_SLACK) {
          stopped = true;
          badStream = true;
          reportUnreadable();
          return;
        }
        actualCrc32 = updateCrc32(actualCrc32, chunk, budget);
        output.push(chunk);
      };

      try {
        if (data.method === 0) {
          for (let offset = 0; offset < compressed.length && !stopped; offset += 16 * 1024) {
            budget.tick();
            const end = Math.min(offset + 16 * 1024, compressed.length);
            compressedFed = end;
            ondata(compressed.subarray(offset, end));
          }
        } else {
          const inflater = new Inflate(ondata);
          if (compressed.length === 0) {
            badStream = true;
          } else {
            for (let offset = 0; offset < compressed.length && !stopped; offset += INFLATE_INPUT_CHUNK) {
              budget.tick();
              const end = Math.min(offset + INFLATE_INPUT_CHUNK, compressed.length);
              compressedFed = end;
              inflater.push(compressed.subarray(offset, end), end === compressed.length);
            }
          }
        }
      } catch (error) {
        if (error instanceof DocsluiceError) throw error;
        badStream = true;
      }

      if (stoppedByBudget) return null;
      if (badStream || outputSize !== data.uncompressedSize || actualCrc32 !== data.crc32) {
        reportUnreadable();
        return null;
      }

      const result = new Uint8Array(outputSize);
      let offset = 0;
      for (const chunk of output) {
        budget.tick();
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    },
  };
}

function findEocd(view: DataView, budget: Budget): number {
  if (view.byteLength < EOCD_MIN_SIZE) throw new CorruptFileError();
  const first = Math.max(0, view.byteLength - MAX_EOCD_SEARCH);
  for (let offset = view.byteLength - EOCD_MIN_SIZE; offset >= first; offset -= 1) {
    budget.tick();
    if (view.getUint32(offset, true) !== EOCD_SIGNATURE) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_MIN_SIZE + commentLength === view.byteLength) return offset;
  }
  throw new CorruptFileError();
}

function readDirectoryBounds(
  view: DataView,
  eocd: number,
): { start: number; size: number; entryCount: number } {
  const disk = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  let size = view.getUint32(eocd + 12, true);
  let start = view.getUint32(eocd + 16, true);
  let entryCount = totalEntries;
  const hasZip64 =
    disk === 0xffff ||
    directoryDisk === 0xffff ||
    diskEntries === 0xffff ||
    totalEntries === 0xffff ||
    size === 0xffffffff ||
    start === 0xffffffff;

  if (hasZip64) {
    const locator = eocd - 20;
    if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR_SIGNATURE)
      throw new CorruptFileError();
    if (view.getUint32(locator + 4, true) !== 0 || view.getUint32(locator + 16, true) !== 1) {
      throw new CorruptFileError();
    }
    const zip64Offset = safeNumber(view.getBigUint64(locator + 8, true));
    if (
      zip64Offset === null ||
      zip64Offset + 56 > locator ||
      view.getUint32(zip64Offset, true) !== ZIP64_EOCD_SIGNATURE
    ) {
      throw new CorruptFileError();
    }
    const recordSize = safeNumber(view.getBigUint64(zip64Offset + 4, true));
    if (recordSize === null || recordSize < 44 || zip64Offset + 12 + recordSize > locator)
      throw new CorruptFileError();
    if (view.getUint32(zip64Offset + 16, true) !== 0 || view.getUint32(zip64Offset + 20, true) !== 0) {
      throw new CorruptFileError();
    }
    const diskCount = safeNumber(view.getBigUint64(zip64Offset + 24, true));
    const count = safeNumber(view.getBigUint64(zip64Offset + 32, true));
    const zip64Size = safeNumber(view.getBigUint64(zip64Offset + 40, true));
    const zip64Start = safeNumber(view.getBigUint64(zip64Offset + 48, true));
    if (
      diskCount === null ||
      count === null ||
      zip64Size === null ||
      zip64Start === null ||
      diskCount !== count
    ) {
      throw new CorruptFileError();
    }
    entryCount = count;
    size = zip64Size;
    start = zip64Start;
  } else if (disk !== 0 || directoryDisk !== 0 || diskEntries !== totalEntries) {
    throw new CorruptFileError();
  }

  const metadataStart = hasZip64 ? eocd - 20 : eocd;
  if (!Number.isSafeInteger(entryCount) || start > metadataStart || size > metadataStart - start) {
    throw new CorruptFileError();
  }
  return { start, size, entryCount };
}

function parseDirectory(
  view: DataView,
  bounds: { start: number; size: number; entryCount: number },
  budget: Budget,
): DirectoryRecord[] {
  const end = bounds.start + bounds.size;
  let cursor = bounds.start;
  const records: DirectoryRecord[] = [];
  for (let index = 0; index < bounds.entryCount; index += 1) {
    budget.tick();
    if (cursor + 46 > end || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) throw new CorruptFileError();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc32 = view.getUint32(cursor + 16, true);
    const compressed32 = view.getUint32(cursor + 20, true);
    const uncompressed32 = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const disk16 = view.getUint16(cursor + 34, true);
    const local32 = view.getUint32(cursor + 42, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new CorruptFileError();
    const nameBytes = new Uint8Array(view.buffer, view.byteOffset + cursor + 46, nameLength);
    const extraStart = cursor + 46 + nameLength;
    const zip64 = readZip64Extra(
      view,
      extraStart,
      extraLength,
      uncompressed32 === 0xffffffff,
      compressed32 === 0xffffffff,
      local32 === 0xffffffff,
      disk16 === 0xffff,
      budget,
    );
    const compressedSize = compressed32 === 0xffffffff ? zip64.compressed : compressed32;
    const uncompressedSize = uncompressed32 === 0xffffffff ? zip64.uncompressed : uncompressed32;
    const localOffset = local32 === 0xffffffff ? zip64.offset : local32;
    const disk = disk16 === 0xffff ? zip64.disk : disk16;
    if (
      compressedSize === null ||
      uncompressedSize === null ||
      localOffset === null ||
      disk === null ||
      disk !== 0
    ) {
      throw new CorruptFileError();
    }
    records.push({
      nameBytes,
      flags,
      method,
      crc32,
      compressedSize,
      uncompressedSize,
      localOffset,
      disk,
    });
    cursor = next;
  }
  if (cursor !== end) throw new CorruptFileError();
  return records;
}

function readZip64Extra(
  view: DataView,
  start: number,
  length: number,
  needUncompressed: boolean,
  needCompressed: boolean,
  needOffset: boolean,
  needDisk: boolean,
  budget: Budget,
): { uncompressed: number | null; compressed: number | null; offset: number | null; disk: number | null } {
  const result = {
    uncompressed: null as number | null,
    compressed: null as number | null,
    offset: null as number | null,
    disk: null as number | null,
  };
  let cursor = start;
  const end = start + length;
  while (cursor < end) {
    budget.tick();
    if (cursor + 4 > end) throw new CorruptFileError();
    const id = view.getUint16(cursor, true);
    const fieldLength = view.getUint16(cursor + 2, true);
    const fieldStart = cursor + 4;
    const fieldEnd = fieldStart + fieldLength;
    if (fieldEnd > end) throw new CorruptFileError();
    if (id === ZIP64_EXTRA_ID) {
      let valueAt = fieldStart;
      const read64 = (): number | null => {
        if (valueAt + 8 > fieldEnd) throw new CorruptFileError();
        const value = safeNumber(view.getBigUint64(valueAt, true));
        valueAt += 8;
        return value;
      };
      if (needUncompressed) result.uncompressed = read64();
      if (needCompressed) result.compressed = read64();
      if (needOffset) result.offset = read64();
      if (needDisk) {
        if (valueAt + 4 > fieldEnd) throw new CorruptFileError();
        result.disk = view.getUint32(valueAt, true);
      }
    }
    cursor = fieldEnd;
  }
  return result;
}

function inspectLocalHeader(
  view: DataView,
  record: DirectoryRecord,
  directoryStart: number,
  budget: Budget,
): { dataStart: number; rangeEnd: number } | null {
  budget.tick();
  const offset = record.localOffset;
  if (
    offset > directoryStart ||
    directoryStart - offset < 30 ||
    view.getUint32(offset, true) !== LOCAL_SIGNATURE
  )
    return null;
  const flags = view.getUint16(offset + 6, true);
  const method = view.getUint16(offset + 8, true);
  const crc32 = view.getUint32(offset + 14, true);
  const localCompressedSize = view.getUint32(offset + 18, true);
  const localUncompressedSize = view.getUint32(offset + 22, true);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  if (dataStart > directoryStart || dataStart > view.byteLength) return null;
  if (method !== record.method || flags !== record.flags) return null;
  if ((record.flags & DATA_DESCRIPTOR_FLAG) === 0) {
    if (crc32 !== record.crc32) return null;
    let resolvedLocalCompressedSize: number | null = localCompressedSize;
    let resolvedLocalUncompressedSize: number | null = localUncompressedSize;
    if (resolvedLocalCompressedSize === 0xffffffff || resolvedLocalUncompressedSize === 0xffffffff) {
      try {
        const zip64 = readZip64Extra(
          view,
          offset + 30 + nameLength,
          extraLength,
          resolvedLocalUncompressedSize === 0xffffffff,
          resolvedLocalCompressedSize === 0xffffffff,
          false,
          false,
          budget,
        );
        if (resolvedLocalUncompressedSize === 0xffffffff) resolvedLocalUncompressedSize = zip64.uncompressed;
        if (resolvedLocalCompressedSize === 0xffffffff) resolvedLocalCompressedSize = zip64.compressed;
      } catch (error) {
        if (error instanceof CorruptFileError) return null;
        throw error;
      }
    }
    if (
      resolvedLocalCompressedSize !== record.compressedSize ||
      resolvedLocalUncompressedSize !== record.uncompressedSize
    ) {
      return null;
    }
  }
  if (offset + 30 + nameLength > directoryStart || nameLength !== record.nameBytes.length) return null;
  for (let index = 0; index < nameLength; index += 1) {
    budget.tick();
    if (view.getUint8(offset + 30 + index) !== record.nameBytes[index]) return null;
  }
  const dataEnd = dataStart + record.compressedSize;
  let descriptorSize = 0;
  if ((record.flags & DATA_DESCRIPTOR_FLAG) !== 0) {
    descriptorSize = inspectDataDescriptor(
      view,
      dataEnd,
      directoryStart,
      record,
      budget,
      localCompressedSize === 0xffffffff ||
        localUncompressedSize === 0xffffffff ||
        record.compressedSize > 0xffffffff ||
        record.uncompressedSize > 0xffffffff,
    );
    if (descriptorSize === 0) return null;
  }
  const rangeEnd = dataEnd + descriptorSize;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > directoryStart || rangeEnd > directoryStart) return null;
  return { dataStart, rangeEnd };
}

function inspectDataDescriptor(
  view: DataView,
  start: number,
  limit: number,
  record: DirectoryRecord,
  budget: Budget,
  zip64: boolean,
): number {
  const hasSignature = start + 4 <= limit && view.getUint32(start, true) === 0x08074b50;
  const prefixes = hasSignature ? [4, 0] : [0];
  for (const prefix of prefixes) {
    budget.tick();
    const valueStart = start + prefix;
    const width = zip64 ? 8 : 4;
    const end = valueStart + 4 + width * 2;
    if (end > limit || view.getUint32(valueStart, true) !== record.crc32) continue;
    const compressed = zip64
      ? safeNumber(view.getBigUint64(valueStart + 4, true))
      : view.getUint32(valueStart + 4, true);
    const uncompressed = zip64
      ? safeNumber(view.getBigUint64(valueStart + 4 + width, true))
      : view.getUint32(valueStart + 4 + width, true);
    if (compressed === record.compressedSize && uncompressed === record.uncompressedSize) return end - start;
  }
  return 0;
}

function detectOverlaps(ranges: LocalRange[], budget: Budget): void {
  ranges.sort((left, right) => {
    budget.tick();
    return left.start - right.start;
  });
  let farthest: LocalRange | undefined;
  for (const range of ranges) {
    budget.tick();
    if (farthest && range.start < farthest.end) {
      range.data.unreadable = true;
      farthest.data.unreadable = true;
      warnUnreadable(budget);
    }
    if (!farthest || range.end > farthest.end) farthest = range;
  }
}

function decodeName(name: Uint8Array, utf8: boolean, budget: Budget): string {
  if (utf8) {
    for (let index = 0; index < name.length; index += 1) budget.tick();
    return new TextDecoder('utf-8').decode(name);
  }
  let decoded = '';
  for (const byte of name) {
    budget.tick();
    decoded += byte < 0x80 ? String.fromCharCode(byte) : (CP437_HIGH[byte - 0x80] ?? '�');
  }
  return decoded;
}

function cleanName(input: string, budget: Budget): string {
  let normalized = '';
  for (let index = 0; index < input.length; index += 1) {
    budget.tick();
    const character = input[index]!;
    const code = input.charCodeAt(index);
    normalized += character === '\\' ? '/' : code <= 0x1f || (code >= 0x7f && code <= 0x9f) ? '�' : character;
  }
  if (
    normalized.length >= 2 &&
    isAsciiLetter(normalized.charCodeAt(0)) &&
    normalized.charCodeAt(1) === 0x3a
  ) {
    normalized = normalized.slice(2);
  }
  const trailingSlash = normalized.endsWith('/');
  const segments: string[] = [];
  let segmentStart = 0;
  for (let index = 0; index <= normalized.length; index += 1) {
    budget.tick();
    if (index < normalized.length && normalized[index] !== '/') continue;
    const segment = normalized.slice(segmentStart, index);
    if (segment !== '' && segment !== '.' && segment !== '..') segments.push(segment);
    segmentStart = index + 1;
  }
  let clean = '';
  for (const segment of segments) {
    budget.tick();
    clean += clean === '' ? segment : `/${segment}`;
  }
  return trailingSlash && clean !== '' ? `${clean}/` : clean;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function safeNumber(value: bigint): number | null {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function makeCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < table.length; value += 1) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit += 1) {
      remainder = (remainder & 1) !== 0 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    }
    table[value] = remainder >>> 0;
  }
  return table;
}

function updateCrc32(previous: number, bytes: Uint8Array, budget: Budget): number {
  let crc = previous ^ 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    budget.tick();
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function warnUnreadable(budget: Budget): void {
  budget.warnings.add({ code: 'UNREADABLE_PART', message: 'An archive entry could not be read.' });
}

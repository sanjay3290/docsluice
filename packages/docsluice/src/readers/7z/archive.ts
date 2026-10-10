import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import { decodeLzma } from './lzma.js';

// 7z archive headers, from the 7z format description in the LZMA SDK (public domain): the
// signature header, the (possibly LZMA-encoded) header, its streams and its file list.

export const SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;
/** Headers larger than this are refused before decoding (7-Zip's own limit is far lower in practice). */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

const ID = {
  end: 0x00,
  header: 0x01,
  archiveProperties: 0x02,
  additionalStreamsInfo: 0x03,
  mainStreamsInfo: 0x04,
  filesInfo: 0x05,
  packInfo: 0x06,
  unpackInfo: 0x07,
  subStreamsInfo: 0x08,
  size: 0x09,
  crc: 0x0a,
  folder: 0x0b,
  codersUnpackSize: 0x0c,
  numUnpackStream: 0x0d,
  emptyStream: 0x0e,
  emptyFile: 0x0f,
  names: 0x11,
  attributes: 0x15,
  encodedHeader: 0x17,
} as const;
const CODER_COPY = '00';
const CODER_LZMA = '030101';
const CODER_AES = '06f10701';
const DIRECTORY_ATTRIBUTE = 0x10;

export interface SevenZipEntry {
  name: string;
  size: number;
  directory: boolean;
}

export interface SevenZipListing {
  entries: SevenZipEntry[];
  /** Some folder uses the AES coder: file contents are encrypted, names are not. */
  encrypted: boolean;
}

interface Coder {
  id: string;
  properties: Uint8Array;
}

interface Folder {
  coders: Coder[];
  /** The folder's CRC is in UnpackInfo, so a single-stream folder has no SubStreams digest. */
  hasCrc: boolean;
  unpackSizes: number[];
  /** Size of the folder's final output: the stream that is not bound to another coder. */
  unpackSize: number;
}

interface Streams {
  packPosition: number;
  packSizes: number[];
  folders: Folder[];
  /** Unpacked size of each file stream, folder by folder. */
  streamSizes: number[];
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The 7z archive headers are malformed.');
}

/** A bounded little-endian cursor with the 7z variable-length NUMBER encoding. */
class Cursor {
  readonly bytes: Uint8Array;
  offset = 0;
  readonly #budget: Budget;

  constructor(bytes: Uint8Array, budget: Budget) {
    this.bytes = bytes;
    this.#budget = budget;
  }

  byte(): number {
    if (this.offset >= this.bytes.length) throw corrupt();
    return this.bytes[this.offset++]!;
  }

  take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.length)
      throw corrupt();
    const slice = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return slice;
  }

  /** NUMBER: the count of leading one bits in the first byte gives the count of extra bytes. */
  number(): number {
    const first = this.byte();
    let mask = 0x80;
    let value = 0;
    for (let index = 0; index < 8; index++) {
      if ((first & mask) === 0) {
        const high = first & (mask - 1);
        return value + high * 2 ** (8 * index);
      }
      value += this.byte() * 2 ** (8 * index);
      if (!Number.isSafeInteger(value)) throw corrupt();
      mask >>>= 1;
    }
    return value;
  }

  /** A count of items that each take at least `minBytes` bytes of what is left. */
  count(minBytes = 1): number {
    const value = this.number();
    if (value > (this.bytes.length - this.offset) / minBytes) throw corrupt();
    return value;
  }

  bits(count: number): boolean[] {
    const result: boolean[] = [];
    let mask = 0;
    let current = 0;
    for (let index = 0; index < count; index++) {
      this.#budget.tick();
      if (mask === 0) {
        current = this.byte();
        mask = 0x80;
      }
      result.push((current & mask) !== 0);
      mask >>>= 1;
    }
    return result;
  }

  /** "AllAreDefined" byte, then a bit vector when it is zero. */
  definedBits(count: number): boolean[] {
    if (this.byte() !== 0) return Array.from({ length: count }, () => true);
    return this.bits(count);
  }

  skipDigests(count: number): void {
    const defined = this.definedBits(count);
    for (const isDefined of defined) {
      this.#budget.tick();
      if (isDefined) this.take(4);
    }
  }

  expect(id: number): void {
    if (this.byte() !== id) throw corrupt();
  }
}

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

function readFolder(
  cursor: Cursor,
  budget: Budget,
): { coders: Coder[]; outStreams: number; bound: Set<number> } {
  const coderCount = cursor.count(2);
  if (coderCount === 0 || coderCount > 64) throw corrupt();
  const coders: Coder[] = [];
  let inStreams = 0;
  let outStreams = 0;
  for (let index = 0; index < coderCount; index++) {
    budget.tick();
    const flags = cursor.byte();
    if ((flags & 0x80) !== 0) throw corrupt();
    const id = hex(cursor.take(flags & 0x0f));
    let coderIn = 1;
    let coderOut = 1;
    if ((flags & 0x10) !== 0) {
      coderIn = cursor.count();
      coderOut = cursor.count();
      if (coderIn > 64 || coderOut > 64) throw corrupt();
    }
    const properties = (flags & 0x20) !== 0 ? cursor.take(cursor.count()) : new Uint8Array(0);
    coders.push({ id, properties });
    inStreams += coderIn;
    outStreams += coderOut;
  }
  const bound = new Set<number>();
  for (let index = 0; index < outStreams - 1; index++) {
    budget.tick();
    cursor.number();
    bound.add(cursor.number());
  }
  const packed = inStreams - (outStreams - 1);
  if (packed < 1) throw corrupt();
  if (packed > 1) for (let index = 0; index < packed; index++) cursor.number();
  return { coders, outStreams, bound };
}

function readStreams(cursor: Cursor, budget: Budget): Streams {
  const streams: Streams = { packPosition: 0, packSizes: [], folders: [], streamSizes: [] };
  let id = cursor.byte();
  if (id === ID.packInfo) {
    streams.packPosition = cursor.number();
    const count = cursor.count();
    for (id = cursor.byte(); id !== ID.end; id = cursor.byte()) {
      budget.tick();
      if (id === ID.size) {
        for (let index = 0; index < count; index++) streams.packSizes.push(cursor.number());
      } else if (id === ID.crc) {
        cursor.skipDigests(count);
      } else {
        throw corrupt();
      }
    }
    id = cursor.byte();
  }
  const outCounts: Array<{ outStreams: number; bound: Set<number> }> = [];
  if (id === ID.unpackInfo) {
    cursor.expect(ID.folder);
    const count = cursor.count(2);
    if (cursor.byte() !== 0) throw corrupt();
    for (let index = 0; index < count; index++) {
      budget.tick();
      const folder = readFolder(cursor, budget);
      streams.folders.push({ coders: folder.coders, hasCrc: false, unpackSizes: [], unpackSize: 0 });
      outCounts.push(folder);
    }
    cursor.expect(ID.codersUnpackSize);
    streams.folders.forEach((folder, index) => {
      const { outStreams, bound } = outCounts[index]!;
      for (let stream = 0; stream < outStreams; stream++) {
        budget.tick();
        const size = cursor.number();
        folder.unpackSizes.push(size);
        if (!bound.has(stream)) folder.unpackSize = size;
      }
    });
    for (id = cursor.byte(); id !== ID.end; id = cursor.byte()) {
      budget.tick();
      if (id !== ID.crc) throw corrupt();
      const defined = cursor.definedBits(streams.folders.length);
      defined.forEach((isDefined, index) => {
        budget.tick();
        if (!isDefined) return;
        cursor.take(4);
        streams.folders[index]!.hasCrc = true;
      });
    }
    id = cursor.byte();
  }
  // One stream per folder unless SubStreamsInfo says otherwise.
  const perFolder = streams.folders.map(() => 1);
  if (id === ID.subStreamsInfo) {
    id = cursor.byte();
    if (id === ID.numUnpackStream) {
      for (let index = 0; index < perFolder.length; index++) perFolder[index] = cursor.count();
      id = cursor.byte();
    }
    const explicit = id === ID.size;
    streams.folders.forEach((folder, index) => {
      const count = perFolder[index]!;
      if (count === 0) return;
      let sum = 0;
      for (let stream = 0; stream < count - 1; stream++) {
        budget.tick();
        const size = explicit ? cursor.number() : 0;
        streams.streamSizes.push(size);
        sum += size;
      }
      if (sum > folder.unpackSize) throw corrupt();
      streams.streamSizes.push(folder.unpackSize - sum);
    });
    if (explicit) id = cursor.byte();
    for (; id !== ID.end; id = cursor.byte()) {
      budget.tick();
      if (id !== ID.crc) throw corrupt();
      // Digests for every stream whose CRC its folder does not already give.
      let unknown = 0;
      perFolder.forEach((count, index) => {
        if (count !== 1 || !streams.folders[index]!.hasCrc) unknown += count;
      });
      cursor.skipDigests(unknown);
    }
    id = cursor.byte();
  } else {
    for (const folder of streams.folders) streams.streamSizes.push(folder.unpackSize);
  }
  if (id !== ID.end) throw corrupt();
  return streams;
}

/** Decode a packed header stream (LZMA or stored); undefined when the uncompressed allowance is spent. */
function decodeHeader(bytes: Uint8Array, streams: Streams, budget: Budget): Uint8Array | undefined {
  const folder = streams.folders[0];
  if (!folder || streams.folders.length !== 1) throw corrupt();
  if (folder.coders.some((candidate) => candidate.id === CODER_AES))
    throw new EncryptedError('password-required');
  if (folder.coders.length !== 1) throw corrupt();
  const coder = folder.coders[0]!;
  const start = 32 + streams.packPosition;
  const packSize = streams.packSizes[0] ?? 0;
  if (!Number.isSafeInteger(start + packSize) || start + packSize > bytes.length) throw corrupt();
  const packed = bytes.subarray(start, start + packSize);
  if (folder.unpackSize > MAX_HEADER_BYTES) throw corrupt();
  // The declared size is checked before the output buffer exists: ratio (a hard limit) and bytes.
  budget.checkRatio(packed.length, folder.unpackSize);
  if (!budget.addUncompressed(folder.unpackSize)) return undefined;
  if (coder.id === CODER_COPY) {
    if (packed.length !== folder.unpackSize) throw corrupt();
    return packed;
  }
  if (coder.id === CODER_LZMA) return decodeLzma(packed, coder.properties, folder.unpackSize, budget);
  throw corrupt();
}

function readFiles(cursor: Cursor, streamSizes: readonly number[], budget: Budget): SevenZipEntry[] {
  const count = cursor.count();
  let emptyStreams: boolean[] = [];
  let emptyFiles: boolean[] = [];
  let names: string[] = [];
  let attributes: Array<number | undefined> = [];
  for (let type = cursor.number(); type !== ID.end; type = cursor.number()) {
    budget.tick();
    const property = new Cursor(cursor.take(cursor.number()), budget);
    if (type === ID.emptyStream) {
      emptyStreams = property.bits(count);
    } else if (type === ID.emptyFile) {
      let empties = 0;
      for (const empty of emptyStreams) if (empty) empties++;
      emptyFiles = property.bits(empties);
    } else if (type === ID.names) {
      if (property.byte() !== 0) throw corrupt();
      const text = new TextDecoder('utf-16le').decode(property.take(property.bytes.length - property.offset));
      names = text.split('\0').slice(0, count);
    } else if (type === ID.attributes) {
      const defined = property.definedBits(count);
      if (property.byte() !== 0) throw corrupt();
      attributes = defined.map((isDefined) => {
        budget.tick();
        if (!isDefined) return undefined;
        const view = property.take(4);
        return view[0]! | (view[1]! << 8) | (view[2]! << 16) | (view[3]! << 24);
      });
    }
  }
  const entries: SevenZipEntry[] = [];
  let stream = 0;
  let empty = 0;
  for (let index = 0; index < count; index++) {
    budget.tick();
    const emptyStream = emptyStreams[index] === true;
    let directory = false;
    let size = 0;
    if (emptyStream) {
      directory = emptyFiles[empty++] !== true;
    } else {
      if (stream >= streamSizes.length) throw corrupt();
      size = streamSizes[stream++]!;
    }
    const attribute = attributes[index];
    if (attribute !== undefined && (attribute & DIRECTORY_ATTRIBUTE) !== 0) directory = true;
    entries.push({ name: names[index] ?? '', size, directory });
  }
  return entries;
}

/**
 * List a 7z archive: names, sizes and directories. The header may be stored or LZMA-encoded (the
 * 7-Zip default); an AES-encrypted header fails with `ENCRYPTED`. File contents are not decoded.
 */
export function list7z(bytes: Uint8Array, budget: Budget): SevenZipListing {
  for (let index = 0; index < SIGNATURE.length; index++)
    if (bytes[index] !== SIGNATURE[index]) throw corrupt();
  if (bytes.length < 32) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nextOffset = view.getUint32(12, true) + view.getUint32(16, true) * 2 ** 32;
  const nextSize = view.getUint32(20, true) + view.getUint32(24, true) * 2 ** 32;
  const start = 32 + nextOffset;
  if (!Number.isSafeInteger(start + nextSize) || start + nextSize > bytes.length) throw corrupt();
  if (nextSize === 0) return { entries: [], encrypted: false };
  let header = bytes.subarray(start, start + nextSize);

  // An encoded header is a StreamsInfo whose single folder unpacks to the real header.
  for (let round = 0; round < 4 && header[0] === ID.encodedHeader; round++) {
    budget.tick();
    const cursor = new Cursor(header, budget);
    cursor.byte();
    const decoded = decodeHeader(bytes, readStreams(cursor, budget), budget);
    // The shared uncompressed allowance is spent: the budget has marked the result truncated.
    if (!decoded) return { entries: [], encrypted: false };
    header = decoded;
  }
  const cursor = new Cursor(header, budget);
  cursor.expect(ID.header);
  let id = cursor.byte();
  if (id === ID.archiveProperties) {
    for (let type = cursor.byte(); type !== ID.end; type = cursor.byte()) cursor.take(cursor.number());
    id = cursor.byte();
  }
  if (id === ID.additionalStreamsInfo) {
    readStreams(cursor, budget);
    id = cursor.byte();
  }
  let streams: Streams = { packPosition: 0, packSizes: [], folders: [], streamSizes: [] };
  if (id === ID.mainStreamsInfo) {
    streams = readStreams(cursor, budget);
    id = cursor.byte();
  }
  const entries = id === ID.filesInfo ? readFiles(cursor, streams.streamSizes, budget) : [];
  const encrypted = streams.folders.some((folder) => folder.coders.some((coder) => coder.id === CODER_AES));
  return { entries, encrypted };
}

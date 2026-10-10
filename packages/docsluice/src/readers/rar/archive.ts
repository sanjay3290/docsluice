import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import type { ListedEntry } from '../archive-list/index.js';

// RAR archive headers, from RARLAB's published format notes: "RAR 5.0 archive format" and the
// RAR 1.5-4.x technical note. Only headers are read; no RAR decompression code is used or written.

export const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00] as const;
export const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00] as const;

export interface RarListing {
  entries: ListedEntry[];
  /** Some file data is encrypted (names are readable). */
  encrypted: boolean;
  /** A header failed its CRC or ran past the end after some entries were read. */
  damaged: boolean;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit++)
      remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    table[value] = remainder >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, budget: Budget): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    if ((index & 0xfff) === 0) budget.tick();
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The RAR archive headers are malformed.');
}

export function hasSignature(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let index = 0; index < signature.length; index++) if (bytes[index] !== signature[index]) return false;
  return true;
}

/** RAR5 vint: 7 bits per byte, low bits first, high bit set on every byte but the last. */
function vint(bytes: Uint8Array, offset: number, end: number): { value: number; next: number } {
  let value = 0;
  for (let index = 0; index < 10; index++) {
    if (offset + index >= end) throw corrupt();
    const byte = bytes[offset + index]!;
    value += (byte & 0x7f) * 2 ** (7 * index);
    if (!Number.isSafeInteger(value)) throw corrupt();
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  throw corrupt();
}

const utf8 = new TextDecoder('utf-8');
const legacy = new TextDecoder('windows-1252');

/** RAR 5.0: blocks of CRC32, vint size, vint type, vint flags, optional extra and data sizes. */
function listRar5(bytes: Uint8Array, budget: Budget): RarListing {
  const listing: RarListing = { entries: [], encrypted: false, damaged: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = RAR5_SIGNATURE.length;
  while (offset < bytes.length) {
    budget.tick();
    try {
      if (offset + 5 > bytes.length) throw corrupt();
      const storedCrc = view.getUint32(offset, true);
      const size = vint(bytes, offset + 4, bytes.length);
      const headerEnd = size.next + size.value;
      if (size.value === 0 || headerEnd > bytes.length) throw corrupt();
      if (crc32(bytes.subarray(offset + 4, headerEnd), budget) !== storedCrc) throw corrupt();
      const type = vint(bytes, size.next, headerEnd);
      const flags = vint(bytes, type.next, headerEnd);
      let cursor = flags.next;
      let extraSize = 0;
      let dataSize = 0;
      if (flags.value & 0x1) {
        const extra = vint(bytes, cursor, headerEnd);
        extraSize = extra.value;
        cursor = extra.next;
      }
      if (flags.value & 0x2) {
        const data = vint(bytes, cursor, headerEnd);
        dataSize = data.value;
        cursor = data.next;
      }
      if (extraSize > headerEnd - cursor) throw corrupt();
      if (type.value === 4) throw new EncryptedError('password-required');
      if (type.value === 5) return listing;
      if (type.value === 2) {
        const fileFlags = vint(bytes, cursor, headerEnd);
        const unpacked = vint(bytes, fileFlags.next, headerEnd);
        cursor = vint(bytes, unpacked.next, headerEnd).next; // attributes
        if (fileFlags.value & 0x2) cursor += 4;
        if (fileFlags.value & 0x4) cursor += 4;
        cursor = vint(bytes, cursor, headerEnd).next; // compression information
        cursor = vint(bytes, cursor, headerEnd).next; // host OS
        const nameLength = vint(bytes, cursor, headerEnd);
        const nameEnd = nameLength.next + nameLength.value;
        if (nameEnd > headerEnd - extraSize) throw corrupt();
        // Extra area records: size, type, data. Type 1 is file encryption.
        for (let record = headerEnd - extraSize; record < headerEnd;) {
          budget.tick();
          const recordSize = vint(bytes, record, headerEnd);
          const recordEnd = recordSize.next + recordSize.value;
          if (recordSize.value === 0 || recordEnd > headerEnd) throw corrupt();
          if (vint(bytes, recordSize.next, recordEnd).value === 1) listing.encrypted = true;
          record = recordEnd;
        }
        listing.entries.push({
          name: utf8.decode(bytes.subarray(nameLength.next, nameEnd)),
          size: (fileFlags.value & 0x8) !== 0 ? 0 : unpacked.value,
          directory: (fileFlags.value & 0x1) !== 0,
        });
      }
      const next = headerEnd + dataSize;
      if (!Number.isSafeInteger(next) || next > bytes.length) throw corrupt();
      offset = next;
    } catch (error) {
      if (!(error instanceof CorruptFileError) || listing.entries.length === 0) throw error;
      listing.damaged = true;
      return listing;
    }
  }
  return listing;
}

/** RAR 1.5-4.x: blocks of CRC16, type, flags, size and an optional 32-bit data size. */
function listRar4(bytes: Uint8Array, budget: Budget): RarListing {
  const listing: RarListing = { entries: [], encrypted: false, damaged: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset: number = RAR4_SIGNATURE.length;
  while (offset + 7 <= bytes.length) {
    budget.tick();
    try {
      const storedCrc = view.getUint16(offset, true);
      const type = bytes[offset + 2]!;
      const flags = view.getUint16(offset + 3, true);
      const size = view.getUint16(offset + 5, true);
      const headerEnd = offset + size;
      if (size < 7 || headerEnd > bytes.length) throw corrupt();
      if (type === 0x7b) return listing;
      let dataSize = 0;
      if (flags & 0x8000) {
        if (size < 11) throw corrupt();
        dataSize = view.getUint32(offset + 7, true);
      }
      if (type === 0x73 || type === 0x74) {
        if ((crc32(bytes.subarray(offset + 2, headerEnd), budget) & 0xffff) !== storedCrc) throw corrupt();
      }
      if (type === 0x73 && flags & 0x0080) throw new EncryptedError('password-required');
      if (type === 0x74) {
        if (size < 32) throw corrupt();
        let unpacked = view.getUint32(offset + 11, true);
        let nameStart = offset + 32;
        if (flags & 0x100) {
          if (size < 40) throw corrupt();
          dataSize += view.getUint32(offset + 32, true) * 2 ** 32;
          unpacked += view.getUint32(offset + 36, true) * 2 ** 32;
          nameStart += 8;
        }
        const nameEnd = nameStart + view.getUint16(offset + 26, true);
        if (nameEnd > headerEnd) throw corrupt();
        let name = bytes.subarray(nameStart, nameEnd);
        let decoder = legacy;
        if (flags & 0x200) {
          // A Unicode name holds a legacy name, NUL, then RAR's own compact encoding, which is not
          // in the published notes: keep the legacy part. Without the NUL the name is UTF-8.
          const nul = name.indexOf(0);
          if (nul >= 0) name = name.subarray(0, nul);
          else decoder = utf8;
        }
        if (flags & 0x04) listing.encrypted = true;
        listing.entries.push({
          name: decoder.decode(name),
          size: unpacked,
          directory: (flags & 0xe0) === 0xe0,
        });
      }
      const next = headerEnd + dataSize;
      if (!Number.isSafeInteger(next) || next > bytes.length) throw corrupt();
      offset = next;
    } catch (error) {
      if (!(error instanceof CorruptFileError) || listing.entries.length === 0) throw error;
      listing.damaged = true;
      return listing;
    }
  }
  return listing;
}

/** List a RAR 4 or RAR 5 archive from its headers. Encrypted headers fail with `ENCRYPTED`. */
export function listRar(bytes: Uint8Array, budget: Budget): RarListing {
  if (hasSignature(bytes, RAR5_SIGNATURE)) return listRar5(bytes, budget);
  if (hasSignature(bytes, RAR4_SIGNATURE)) return listRar4(bytes, budget);
  throw corrupt();
}

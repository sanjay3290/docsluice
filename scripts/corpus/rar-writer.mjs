// Deterministic RAR writers for the corpus and hostile generators, from RARLAB's published notes
// ("RAR 5.0 archive format" and the RAR 1.5-4.x technical note). Files are stored (no
// compression), which is all a header-listing reader needs and all that the notes fully describe.
import { TextEncoder } from 'node:util';

const encoder = new TextEncoder();
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let remainder = value;
    for (let bit = 0; bit < 8; bit++) remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
    table[value] = remainder >>> 0;
  }
  return table;
})();
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function concat(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
const u16 = (value) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);
const u32 = (value) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
export function vint(value) {
  const bytes = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return Uint8Array.from(bytes);
}
/** 2026-01-01 00:00:00 as a DOS date and time. */
const DOS_TIME = ((2026 - 1980) << 25) | (1 << 21) | (1 << 16);
const UNIX_TIME = 1_767_225_600;

/**
 * RAR 5.0. `entries`: { name, data?, directory?, encrypted? }. `damage(index, bytes)` may change a
 * block's bytes after its CRC is computed. `encryptHeaders` writes an archive encryption header.
 */
export function rar5(entries, { encryptHeaders = false, damage } = {}) {
  const blocks = [Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00)];
  const block = (fields, { extra, data } = {}) => {
    const [type, ...rest] = fields;
    let flags = 0;
    const sizes = [];
    if (extra) {
      flags |= 0x1;
      sizes.push(vint(extra.length));
    }
    if (data) {
      flags |= 0x2;
      sizes.push(vint(data.length));
    }
    const body = concat([vint(type), vint(flags), ...sizes, ...rest, ...(extra ? [extra] : [])]);
    const header = concat([vint(body.length), body]);
    const out = concat([u32(crc32(header)), header, ...(data ? [data] : [])]);
    damage?.(blocks.length - 1, out);
    blocks.push(out);
  };
  if (encryptHeaders) {
    // Archive encryption header: version 0, flags 0, KDF count 15, 16-byte salt.
    block([4, vint(0), vint(0), Uint8Array.of(15), new Uint8Array(16)]);
    return concat(blocks);
  }
  block([1, vint(0)]);
  for (const entry of entries) {
    const data = entry.directory ? undefined : (entry.data ?? new Uint8Array(0));
    const name = encoder.encode(entry.name);
    const fileFlags = (entry.directory ? 0x1 : 0) | 0x2 | (data ? 0x4 : 0);
    // An encryption record (type 1) in the extra area marks encrypted file data.
    const extra = entry.encrypted ? concat([vint(2), vint(1), vint(0)]) : undefined;
    block(
      [
        2,
        vint(fileFlags),
        vint(data?.length ?? 0),
        vint(entry.directory ? 0x10 : 0x20),
        u32(UNIX_TIME),
        ...(data ? [u32(crc32(data))] : []),
        vint(0),
        vint(0),
        vint(name.length),
        name,
      ],
      // libarchive expects a data area on every file header, even an empty one.
      { extra, data: data ?? new Uint8Array(0) },
    );
  }
  block([5, vint(0)]);
  return concat(blocks);
}

/** RAR 1.5-4.x. `entries`: { name, data?, directory?, encrypted?, unicodeName?, packSize? (a lie) }. */
export function rar4(entries, { encryptHeaders = false, damage } = {}) {
  const blocks = [Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00)];
  const block = (type, flags, fields, data) => {
    const size = 7 + fields.length;
    const header = concat([Uint8Array.of(type), u16(flags), u16(size), fields]);
    const out = concat([u16(crc32(header) & 0xffff), header, ...(data ? [data] : [])]);
    damage?.(blocks.length - 1, out);
    blocks.push(out);
  };
  block(0x73, encryptHeaders ? 0x0080 : 0, concat([u16(0), u32(0)]));
  for (const entry of entries) {
    const data = entry.directory ? new Uint8Array(0) : (entry.data ?? new Uint8Array(0));
    const name = entry.unicodeName ? concat([encoder.encode(entry.name), Uint8Array.of(0, 0x00)]) : encoder.encode(entry.name);
    let flags = 0x8000;
    if (entry.directory) flags |= 0xe0;
    if (entry.encrypted) flags |= 0x04;
    if (entry.unicodeName) flags |= 0x200;
    const fields = concat([
      u32(entry.packSize ?? data.length),
      u32(data.length),
      Uint8Array.of(2),
      u32(crc32(data)),
      u32(DOS_TIME),
      Uint8Array.of(29, 0x30),
      u16(name.length),
      u32(entry.directory ? 0x10 : 0x20),
      name,
    ]);
    block(0x74, flags, fields, data);
  }
  block(0x7b, 0x4000, new Uint8Array(0));
  return concat(blocks);
}

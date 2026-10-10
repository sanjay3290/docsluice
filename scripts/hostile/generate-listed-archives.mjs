import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { concat, crc32, rar4, rar5 } from '../corpus/rar-writer.mjs';

// Hostile 7z and RAR files for the opt-in listing plugins (ADR 0014): a 7z header that claims a
// huge LZMA expansion, an LZMA stream that is garbage, a NUMBER that overflows, 12,000 entries,
// damaged and encrypted RAR headers, a RAR size lie and an overlong RAR vint.
const sevenZip = new URL('../../hostile/7z/', import.meta.url);
const rar = new URL('../../hostile/rar/', import.meta.url);
await mkdir(sevenZip, { recursive: true });
await mkdir(rar, { recursive: true });

const u32 = (value) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
const u64 = (value) => concat([u32(value % 2 ** 32), u32(Math.floor(value / 2 ** 32))]);
/** 7z NUMBER: the first byte's leading one bits count the extra little-endian bytes. */
function number(value) {
  if (value < 0x80) return Uint8Array.of(value);
  if (value < 0x4000) return Uint8Array.of(0x80 | (value >>> 8), value & 0xff);
  if (value < 0x20_0000) return Uint8Array.of(0xc0 | (value >>> 16), value & 0xff, (value >>> 8) & 0xff);
  return concat([Uint8Array.of(0xff), u64(value)]);
}
/** A 7z file: signature header, packed data, then the next header (with real CRCs). */
function sevenZipFile(packed, header) {
  const next = concat([u64(packed.length), u64(header.length), u32(crc32(header))]);
  return concat([Uint8Array.of(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4), u32(crc32(next)), next, packed, header]);
}
/** An EncodedHeader: one packed stream at offset 0, one LZMA folder unpacking to `unpackSize`. */
const encodedHeader = (packSize, unpackSize) =>
  concat([
    Uint8Array.of(0x17, 0x06, 0x00, 0x01, 0x09),
    number(packSize),
    Uint8Array.of(0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x23, 0x03, 0x01, 0x01, 0x05, 0x5d, 0x00, 0x00, 0x01, 0x00, 0x0c),
    number(unpackSize),
    Uint8Array.of(0x00, 0x00),
  ]);

// 100 packed bytes that claim to unpack to 50 MB: the ratio check refuses it before decoding.
await writeFile(new URL('header-ratio-bomb.7z', sevenZip), sevenZipFile(new Uint8Array(100), encodedHeader(100, 50_000_000)));

// An LZMA header stream of 0xFF bytes: decoding fails on the first impossible match.
const garbage = concat([Uint8Array.of(0), new Uint8Array(63).fill(0xff)]);
await writeFile(new URL('lzma-garbage.7z', sevenZip), sevenZipFile(garbage, encodedHeader(garbage.length, 1000)));

// A FilesInfo count written as a NUMBER larger than any safe integer.
await writeFile(
  new URL('number-overflow.7z', sevenZip),
  sevenZipFile(new Uint8Array(0), Uint8Array.of(0x01, 0x05, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff)),
);

// 12,000 empty files in a stored header: the listing stops at zipEntries (10,000).
const count = 12_000;
const names = [];
for (let index = 0; index < count; index++) {
  const name = index.toString(36);
  const bytes = new Uint8Array((name.length + 1) * 2);
  for (let char = 0; char < name.length; char++) bytes[char * 2] = name.charCodeAt(char);
  names.push(bytes);
}
const nameData = concat([Uint8Array.of(0), ...names]);
const emptyBits = new Uint8Array(Math.ceil(count / 8)).fill(0xff);
const files = concat([
  Uint8Array.of(0x01, 0x05),
  number(count),
  Uint8Array.of(0x0e),
  number(emptyBits.length),
  emptyBits,
  Uint8Array.of(0x0f),
  number(emptyBits.length),
  emptyBits,
  Uint8Array.of(0x11),
  number(nameData.length),
  nameData,
  Uint8Array.of(0x00, 0x00),
]);
await writeFile(new URL('entries-12000.7z', sevenZip), sevenZipFile(new Uint8Array(0), files));

const text = (value) => new TextEncoder().encode(value);
const two = [
  { name: 'first.txt', data: text('first') },
  { name: 'second.txt', data: text('second') },
];
// A RAR 5 archive whose second file header fails its CRC: the first entry is kept.
await writeFile(
  new URL('rar5-crc-damage.rar', rar),
  rar5(two, {
    damage: (index, bytes) => {
      if (index === 2) bytes[bytes.length - 8] ^= 0xff;
    },
  }),
);
await writeFile(new URL('rar5-encrypted-headers.rar', rar), rar5([], { encryptHeaders: true }));
await writeFile(new URL('rar4-encrypted-headers.rar', rar), rar4([], { encryptHeaders: true }));
// A RAR 4 file whose packed size points far past the end of the archive.
await writeFile(
  new URL('rar4-size-lie.rar', rar),
  rar4([{ ...two[0], packSize: 0x7fff_ffff }, two[1]]),
);
// A RAR 5 header size written as an eleven-byte vint.
await writeFile(
  new URL('rar5-vint-overflow.rar', rar),
  concat([Uint8Array.of(0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00), u32(0), new Uint8Array(11).fill(0xff)]),
);
// 12,000 empty RAR 5 files: the listing stops at zipEntries (10,000).
const many = [];
for (let index = 0; index < count; index++) many.push({ name: index.toString(36), data: new Uint8Array(0) });
await writeFile(new URL('rar5-entries-12000.rar', rar), rar5(many));

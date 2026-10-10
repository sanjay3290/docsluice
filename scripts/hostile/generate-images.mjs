import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile image headers: IFD chains that loop, sub-IFD pointers back to IFD0, entry counts and value
// offsets past the data, a JPEG segment-length lie, PNG and WebP chunk-size lies, and a flood of
// JPEG fill bytes. Only headers matter: docsluice never decodes pixels.
const directory = new URL('../../hostile/image/', import.meta.url);
await mkdir(directory, { recursive: true });

const le16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const entry = (tag, type, count, value) => [...le16(tag), ...le16(type), ...le32(count), ...le32(value)];

/** A little-endian TIFF with one IFD at offset 8 holding `entries`, then `next` as the next-IFD offset. */
const tiff = (entries, next, tail = []) =>
  Uint8Array.from([...ascii('II'), ...le16(42), ...le32(8), ...le16(entries.length), ...entries.flat(), ...le32(next), ...tail]);

const files = new Map([
  // IFD0's next-IFD offset points back at itself.
  ['ifd-self-loop.tif', tiff([entry(256, 3, 1, 4), entry(257, 3, 1, 3)], 8)],
  // The EXIF and GPS sub-IFD pointers point back at IFD0.
  ['subifd-loop.tif', tiff([entry(256, 3, 1, 4), entry(257, 3, 1, 3), entry(34665, 4, 1, 8), entry(34853, 4, 1, 8)], 0)],
  // An entry count of 65,535 in a 30-byte file.
  ['huge-entry-count.tif', Uint8Array.from([...ascii('II'), ...le16(42), ...le32(8), ...le16(0xffff), ...entry(256, 3, 1, 4)])],
  // ASCII and RATIONAL values whose offsets and counts run far past the data.
  ['value-offset-lie.tif', tiff([entry(256, 3, 1, 4), entry(271, 2, 0x7fffffff, 0x7ffffff0), entry(306, 2, 20, 0xfffffff0)], 0)],
  // A JPEG whose APP1 segment claims 65,535 bytes, then ends.
  ['jpeg-segment-lie.jpg', Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...be16(0xffff), ...ascii('Exif'), 0, 0])],
  // 200,000 fill bytes between markers, then a frame header.
  ['jpeg-fill-flood.jpg', Uint8Array.from([0xff, 0xd8, ...new Array(200_000).fill(0xff), 0xc0, ...be16(11), 8, ...be16(2), ...be16(3), 1, 1, 0x11, 0, 0xff, 0xd9])],
  // A PNG whose second chunk claims four gigabytes.
  ['png-chunk-lie.png', Uint8Array.from([0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(1), ...be32(1), 8, 2, 0, 0, 0, 0, 0, 0, 0, ...be32(0xfffffff0), ...ascii('eXIf'), 1, 2, 3])],
  // A WebP whose EXIF chunk holds a looping IFD and whose next chunk lies about its size.
  [
    'webp-exif-loop.webp',
    Uint8Array.from([
      ...ascii('RIFF'),
      ...le32(60),
      ...ascii('WEBP'),
      ...ascii('VP8X'),
      ...le32(10),
      0,
      0,
      0,
      0,
      ...[1, 0, 0],
      ...[1, 0, 0],
      ...ascii('EXIF'),
      ...le32(26),
      ...tiff([entry(274, 3, 1, 1)], 8),
      ...ascii('ICCP'),
      ...le32(0x7fffffff),
    ]),
  ],
]);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);

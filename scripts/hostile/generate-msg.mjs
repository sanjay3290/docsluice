import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { msg, utf8 } from '../corpus/msg-writer.mjs';

// Hostile Outlook .msg files: LZFu bodies that lie about their size, a directory loop through an
// attachment storage, embedded messages nested past childDepth, thousands of attachments and a
// property stream full of junk tags.
const directory = new URL('../../hostile/msg/', import.meta.url);
await mkdir(directory, { recursive: true });

/** An LZFu stream header over `payload` with a chosen raw size and the payload's real CRC. */
function lzfu(payload, rawSize) {
  let crc = 0;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  const bytes = new Uint8Array(16 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, payload.length + 12, true);
  view.setUint32(4, rawSize, true);
  view.setUint32(8, 0x75465a4c, true);
  view.setUint32(12, crc >>> 0, true);
  bytes.set(payload, 16);
  return bytes;
}

// Every token is a 17-byte back-reference to offset 0 of the dictionary: the most output LZFu can
// make from its input (8:1). 64 KiB in, 512 KiB out, while the header claims 4 GiB.
const references = new Uint8Array(65_536 + 1);
for (let offset = 0; offset + 17 <= references.length; offset += 17) {
  references[offset] = 0xff;
  for (let token = 0; token < 8; token++) {
    references[offset + 1 + token * 2] = 0x00;
    references[offset + 2 + token * 2] = 0x0f;
  }
}
const files = new Map([
  ['lzfu-bomb.msg', msg({ strings: [[0x0037, 'LZFu bomb']], binaries: [[0x1009, lzfu(references, 0xffff_ffff)]] })],
  [
    'lzfu-size-lie.msg',
    msg({
      strings: [[0x0037, 'LZFu size lie']],
      binaries: [[0x1009, lzfu(Uint8Array.of(0x00, 0x7b, 0x5c, 0x72, 0x74, 0x66, 0x31, 0x20, 0x78), 0x7fff_ffff)]],
    }),
  ],
]);

// A forwarded message nested 40 levels deep (the default childDepth is lower).
let nested = { strings: [[0x0037, 'innermost'], [0x1000, 'bottom']] };
for (let level = 0; level < 40; level++) {
  nested = {
    strings: [[0x0037, `level ${level}`]],
    attachments: [{ strings: [[0x3001, `level ${level}`]], longs: [[0x3705, 5]], embedded: nested }],
  };
}
files.set('embedded-nesting.msg', msg(nested));

// 2,000 attachments of one byte each (8,000 directory entries, under zipEntries): entries, children and time stay bounded.
files.set(
  'many-attachments.msg',
  msg({
    strings: [[0x1000, 'Many attachments.']],
    attachments: Array.from({ length: 2_000 }, (_, index) => ({
      strings: [[0x3707, `a${index}.txt`]],
      binaries: [[0x3701, utf8('x')]],
      longs: [[0x3705, 1]],
    })),
  }),
);

// 64 KiB of property entries with pseudo-random tags, flags and values over a real body.
let seed = 0x1234_5678;
const random = () => {
  seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
  return seed;
};
const junk = new Uint8Array(32 + 4_096 * 16);
for (let offset = 32; offset < junk.length; offset++) junk[offset] = random() >>> 24;
files.set('junk-properties.msg', msg({ strings: [[0x1000, 'Junk properties.']], rawProperties: junk }));

/** The directory entries of a compound file written by msg-writer, with their byte offsets. */
function directoryEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = view.getUint32(48, true);
  // msg-writer allocates the directory contiguously.
  const start = (first + 1) * 512;
  const result = [];
  for (let offset = start; offset + 128 <= bytes.length; offset += 128) {
    const length = view.getUint16(offset + 64, true);
    if (![1, 2, 5].includes(bytes[offset + 66]) || length < 2 || length > 64 || length % 2 !== 0) break;
    let name = '';
    for (let index = 0; index < length / 2 - 1; index++) name += String.fromCharCode(view.getUint16(offset + index * 2, true));
    result.push({ name, offset, id: result.length });
  }
  return { view, entries: result };
}

// An attachment storage whose child pointer leads back to itself: a directory loop.
const loop = msg({
  strings: [[0x1000, 'Loop.']],
  attachments: [{ strings: [[0x3707, 'loop.txt']], binaries: [[0x3701, utf8('loop')]], longs: [[0x3705, 1]] }],
});
{
  const { view, entries } = directoryEntries(loop);
  const attachment = entries.find((entry) => entry.name === '__attach_version1.0_#00000000');
  view.setUint32(attachment.offset + 76, attachment.id, true);
}
files.set('attachment-loop.msg', loop);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);

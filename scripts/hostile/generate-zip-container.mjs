import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile archives for the ZIP container reader: 10,001 entries (nested, so the repetitive
// directory compresses), and OS junk next to an entry flagged as encrypted.
const directory = new URL('../../hostile/zip/', import.meta.url);
await mkdir(directory, { recursive: true });
const mtime = new Date('1980-01-01T00:00:00Z');

const many = Object.create(null);
for (let index = 0; index <= 10_000; index++) many[`e${index}`] = [new Uint8Array(0), { mtime, level: 0 }];
await writeFile(
  new URL('nested-entries-10001.zip', directory),
  zipSync({ 'many.zip': [zipSync(many), { mtime, level: 9 }] }, { level: 9 }),
);

const junk = Object.create(null);
junk['__MACOSX/._report.txt'] = [strToU8('resource fork'), { mtime }];
junk['.DS_Store'] = [strToU8('cache'), { mtime }];
junk['photos/Thumbs.db'] = [strToU8('cache'), { mtime }];
junk['secret.txt'] = [strToU8('not really encrypted, only flagged'), { mtime, level: 0 }];
junk['report.txt'] = [strToU8('Readable report.'), { mtime }];
const bytes = zipSync(junk, { level: 9 });
// Set the "encrypted" flag (bit 0) on secret.txt in its local and central headers.
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const name = strToU8('secret.txt');
const matches = (offset) => name.every((byte, index) => bytes[offset + index] === byte);
for (let offset = 0; offset + 46 < bytes.length; offset++) {
  const signature = view.getUint32(offset, true);
  if (signature === 0x04034b50 && view.getUint16(offset + 26, true) === name.length && matches(offset + 30)) {
    view.setUint16(offset + 6, view.getUint16(offset + 6, true) | 1, true);
  } else if (signature === 0x02014b50 && view.getUint16(offset + 28, true) === name.length && matches(offset + 46)) {
    view.setUint16(offset + 8, view.getUint16(offset + 8, true) | 1, true);
  }
}
await writeFile(new URL('junk-and-encrypted.zip', directory), bytes);

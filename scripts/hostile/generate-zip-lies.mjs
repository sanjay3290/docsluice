import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { zipSync } from 'fflate';

// ZIP inputs whose headers lie about sizes or counts, plus ratio and nesting probes (SEC-1, SEC-2, SEC-9).
const FIXED_TIME = new Date('1980-01-01T00:00:00.000Z');
const utf8 = new TextEncoder();
const directory = new URL('../../hostile/zip/', import.meta.url);
await mkdir(directory, { recursive: true });

function zip(entries) {
  const archive = Object.create(null);
  for (const [name, content] of entries) archive[name] = [content, { mtime: FIXED_TIME }];
  return zipSync(archive, { level: 9, mtime: FIXED_TIME });
}

function findEocd(view) {
  for (let offset = view.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error('end of central directory not found');
}

function zip64SizeLie() {
  const bytes = zip([['size-lie.bin', utf8.encode('small payload')]]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const central = view.getUint32(findEocd(view) + 16, true);
  view.setUint32(central + 20, 0xffffffff, true);
  view.setUint32(central + 24, 0xffffffff, true);
  return bytes;
}

function zip64CountLie() {
  const regular = zip([['one.txt', utf8.encode('one')]]);
  const view = new DataView(regular.buffer, regular.byteOffset, regular.byteLength);
  const eocd = findEocd(view);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryStart = view.getUint32(eocd + 16, true);
  const record = new Uint8Array(76);
  const wide = new DataView(record.buffer);
  wide.setUint32(0, 0x06064b50, true);
  wide.setBigUint64(4, 44n, true);
  wide.setUint16(12, 45, true);
  wide.setUint16(14, 45, true);
  wide.setBigUint64(24, 1_000_000n, true);
  wide.setBigUint64(32, 1_000_000n, true);
  wide.setBigUint64(40, BigInt(directorySize), true);
  wide.setBigUint64(48, BigInt(directoryStart), true);
  wide.setUint32(56, 0x07064b50, true);
  wide.setBigUint64(64, BigInt(directoryStart + directorySize), true);
  wide.setUint32(72, 1, true);
  const tail = regular.slice(eocd);
  const tailView = new DataView(tail.buffer);
  tailView.setUint16(8, 0xffff, true);
  tailView.setUint16(10, 0xffff, true);
  tailView.setUint32(12, 0xffffffff, true);
  tailView.setUint32(16, 0xffffffff, true);
  const out = new Uint8Array(eocd + record.length + tail.length);
  out.set(regular.subarray(0, eocd));
  out.set(record, eocd);
  out.set(tail, eocd + record.length);
  return out;
}

const repeat = utf8.encode('A'.repeat(1_048_577));
let chain = zip([['payload.txt', utf8.encode('finite recursive-container probe')]]);
for (let depth = 0; depth < 8; depth += 1) chain = zip([['loop.zip', chain]]);

await writeFile(new URL('high-ratio.zip', directory), zip([['repeat.bin', repeat]]));
await writeFile(new URL('nested-high-ratio.zip', directory), zip([['inner.zip', zip([['repeat.bin', repeat]])]]));
await writeFile(new URL('nested-chain-8.zip', directory), chain);
await writeFile(new URL('zip64-size-lie.zip', directory), zip64SizeLie());
await writeFile(new URL('zip64-count-lie.zip', directory), zip64CountLie());
await writeFile(new URL('truncated-central.zip', directory), zip([['one.txt', utf8.encode('one')]]).subarray(0, -7));

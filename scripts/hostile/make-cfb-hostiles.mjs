import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

const size = 512;
const end = 0xffff_fffe;
const free = 0xffff_ffff;
const fatMarker = 0xffff_fffd;
const outDir = new URL('../../hostile/ole/', import.meta.url);
await mkdir(outDir, { recursive: true });

function makeCfb({ fatLoop = false, difatLoop = false, directoryCycle = false, hugeSize = false } = {}) {
  const bytes = new Uint8Array(size * 5);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, 1, true);
  view.setUint32(48, 1, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, end, true);
  view.setUint32(64, 0, true);
  view.setUint32(68, difatLoop ? 3 : end, true);
  view.setUint32(72, difatLoop ? 2 : 0, true);
  for (let index = 0; index < 109; index++) view.setUint32(76 + index * 4, index === 0 ? 0 : free, true);

  const sector = (id) => bytes.subarray((id + 1) * size, (id + 2) * size);
  const fat = new DataView(sector(0).buffer, sector(0).byteOffset, size);
  for (let index = 0; index < size / 4; index++) fat.setUint32(index * 4, free, true);
  fat.setUint32(0, fatMarker, true);
  fat.setUint32(4, end, true);
  fat.setUint32(8, fatLoop ? 2 : end, true);
  if (difatLoop) {
    const difat = new DataView(sector(3).buffer, sector(3).byteOffset, size);
    for (let index = 0; index < size / 4 - 1; index++) difat.setUint32(index * 4, free, true);
    difat.setUint32(size - 4, 3, true);
  }
  sector(2).set([0x62, 0x6f, 0x75, 0x6e, 0x64, 0x65, 0x64, 0x20, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]);

  const dir = new DataView(sector(1).buffer, sector(1).byteOffset, size);
  const name = (entry, value) => {
    for (let index = 0; index < value.length; index++) dir.setUint16(entry * 128 + index * 2, value.charCodeAt(index), true);
    dir.setUint16(entry * 128 + 64, (value.length + 1) * 2, true);
  };
  name(0, 'Root Entry');
  dir.setUint8(66, 5);
  dir.setUint32(68, free, true);
  dir.setUint32(72, free, true);
  dir.setUint32(76, 1, true);
  dir.setUint32(116, end, true);
  name(1, 'HugeStream');
  dir.setUint8(128 + 66, 2);
  dir.setUint32(128 + 68, directoryCycle ? 1 : free, true);
  dir.setUint32(128 + 72, free, true);
  dir.setUint32(128 + 76, free, true);
  dir.setUint32(128 + 116, 2, true);
  dir.setUint32(128 + 120, hugeSize || fatLoop ? 0xffff_ffff : 14, true);
  return bytes;
}

for (const [filename, options] of Object.entries({
  'fat-loop.cfb': { fatLoop: true },
  'difat-loop.cfb': { difatLoop: true },
  'directory-cycle.cfb': { directoryCycle: true },
  'huge-stream-size.cfb': { hugeSize: true },
})) {
  await writeFile(new URL(filename, outDir), makeCfb(options));
}

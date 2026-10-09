import { mkdirSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const destination = new URL('../../hostile/zip/', import.meta.url);
mkdirSync(destination, { recursive: true });
const crcTable = new Uint32Array(256);
for (let value = 0; value < crcTable.length; value += 1) {
  let remainder = value;
  for (let bit = 0; bit < 8; bit += 1) remainder = (remainder & 1) !== 0 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  crcTable[value] = remainder >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(entries, { overlap = false } = {}) {
  const local = [];
  const central = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const content = entry.data;
    const compressed = entry.method === 8 ? deflateRawSync(content) : content;
    const checksum = crc32(content);
    const wide = entry.declaredSize > 0xffffffff;
    const localExtra = wide ? Buffer.alloc(12) : Buffer.alloc(0);
    if (wide) {
      localExtra.writeUInt16LE(1, 0);
      localExtra.writeUInt16LE(8, 2);
      localExtra.writeBigUInt64LE(BigInt(entry.declaredSize), 4);
    }
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(45, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(entry.method ?? 0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(wide ? 0xffffffff : entry.declaredSize ?? content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(localExtra.length, 28);
    local.push(localHeader, name, localExtra, compressed);

    const centralExtra = wide ? Buffer.alloc(12) : Buffer.alloc(0);
    if (wide) {
      centralExtra.writeUInt16LE(1, 0);
      centralExtra.writeUInt16LE(8, 2);
      centralExtra.writeBigUInt64LE(BigInt(entry.declaredSize), 4);
    }
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(45, 4);
    centralHeader.writeUInt16LE(45, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(entry.method ?? 0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(wide ? 0xffffffff : entry.declaredSize ?? content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(centralExtra.length, 30);
    centralHeader.writeUInt32LE(overlap && central.length > 0 ? 0 : localOffset, 42);
    central.push(centralHeader, name, centralExtra);
    localOffset += localHeader.length + name.length + localExtra.length + compressed.length;
  }

  const localBytes = Buffer.concat(local);
  const centralBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localBytes.length, 16);
  return Buffer.concat([localBytes, centralBytes, eocd]);
}

const bombSize = 42 * 1024 * 1024;
writeFileSync(
  new URL('bomb-42k.zip', destination),
  makeZip([{ name: 'bomb.bin', data: Buffer.alloc(bombSize), method: 8, declaredSize: 0x1_0000_0000 }]),
);

const oversizedContentTypesSize = 50 * 1024 * 1024;
const oversizedContentTypes = Buffer.alloc(oversizedContentTypesSize, 0x20);
Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>').copy(
  oversizedContentTypes,
);
writeFileSync(
  new URL('content-types-50mb.zip', destination),
  makeZip([
    {
      name: '[Content_Types].xml',
      data: oversizedContentTypes,
      method: 8,
      declaredSize: oversizedContentTypesSize,
    },
  ]),
);

const zip64Count = Buffer.alloc(98);
zip64Count.writeUInt32LE(0x06064b50, 0);
zip64Count.writeBigUInt64LE(44n, 4);
zip64Count.writeUInt16LE(45, 12);
zip64Count.writeUInt16LE(45, 14);
zip64Count.writeBigUInt64LE(1_000_000n, 24);
zip64Count.writeBigUInt64LE(1_000_000n, 32);
zip64Count.writeUInt32LE(0x07064b50, 56);
zip64Count.writeBigUInt64LE(0n, 64);
zip64Count.writeUInt32LE(1, 72);
zip64Count.writeUInt32LE(0x06054b50, 76);
zip64Count.writeUInt16LE(0xffff, 84);
zip64Count.writeUInt16LE(0xffff, 86);
zip64Count.writeUInt32LE(0xffffffff, 88);
zip64Count.writeUInt32LE(0xffffffff, 92);
writeFileSync(new URL('many-entries.zip', destination), zip64Count);

writeFileSync(
  new URL('path-traversal.zip', destination),
  makeZip([{ name: '../../etc/passwd', data: Buffer.from('display path only') }]),
);
writeFileSync(
  new URL('overlap.zip', destination),
  makeZip(
    [
      { name: 'same.bin', data: Buffer.from('first') },
      { name: 'same.bin', data: Buffer.from('first') },
    ],
    { overlap: true },
  ),
);

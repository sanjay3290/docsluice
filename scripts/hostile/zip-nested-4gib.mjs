import { createWriteStream, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw, createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const destination = resolve(dirname(fileURLToPath(import.meta.url)), '../../hostile/zip/nested-4gib.zip');
const temporaryGzip = `${destination}.gzip-tmp`;
const temporaryDeflate = `${destination}.inner-deflate-tmp`;
const zeroBytes = 0x1_0000_0000;
const targetArchiveBytes = 42 * 1024;
const chunk = Buffer.alloc(64 * 1024);
const innerName = Buffer.from('zeros.bin');
const outerName = Buffer.from('nested.zip');
const chunkCount = zeroBytes / chunk.length;

async function* zeros() {
  for (let index = 0; index < chunkCount; index += 1) yield chunk;
}

async function crcOfZeros() {
  let tail = Buffer.alloc(0);
  const sink = new Writable({
    write(value, _encoding, callback) {
      tail = Buffer.concat([tail, value]).subarray(-8);
      callback();
    },
  });
  await pipeline(Readable.from(zeros()), createGzip({ level: 1, mtime: 0 }), sink);
  return tail.readUInt32LE(tail.length - 8);
}

function innerLocal(crc, compressedSize) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(45, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(0xffffffff, 22);
  header.writeUInt16LE(innerName.length, 26);
  header.writeUInt16LE(12, 28);
  const extra = Buffer.alloc(12);
  extra.writeUInt16LE(1, 0);
  extra.writeUInt16LE(8, 2);
  extra.writeBigUInt64LE(BigInt(zeroBytes), 4);
  return Buffer.concat([header, innerName, extra]);
}

function innerTail(crc, compressedSize, centralOffset) {
  const central = Buffer.alloc(46 + innerName.length + 12);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressedSize, 20);
  central.writeUInt32LE(0xffffffff, 24);
  central.writeUInt16LE(innerName.length, 28);
  central.writeUInt16LE(12, 30);
  central.writeUInt16LE(1, 46 + innerName.length);
  central.writeUInt16LE(8, 48 + innerName.length);
  central.writeBigUInt64LE(BigInt(zeroBytes), 46 + innerName.length + 4);
  central.set(innerName, 46);

  const zip64Offset = BigInt(centralOffset + central.length);
  const zip64 = Buffer.alloc(56);
  zip64.writeUInt32LE(0x06064b50, 0);
  zip64.writeBigUInt64LE(44n, 4);
  zip64.writeUInt16LE(45, 12);
  zip64.writeUInt16LE(45, 14);
  zip64.writeBigUInt64LE(1n, 24);
  zip64.writeBigUInt64LE(1n, 32);
  zip64.writeBigUInt64LE(BigInt(central.length), 40);
  zip64.writeBigUInt64LE(BigInt(centralOffset), 48);

  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(zip64Offset, 8);
  locator.writeUInt32LE(1, 16);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(0xffffffff, 16);
  return Buffer.concat([central, zip64, locator, eocd]);
}

async function* innerArchive(zeroCrc, compressedZeros) {
  const local = innerLocal(zeroCrc, compressedZeros.length);
  yield local;
  yield compressedZeros;
  yield innerTail(zeroCrc, compressedZeros.length, local.length + compressedZeros.length);
}

function outerArchive(compressed, innerSize, crc) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(innerSize, 22);
  local.writeUInt16LE(outerName.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46 + outerName.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(innerSize, 24);
  central.writeUInt16LE(outerName.length, 28);
  central.set(outerName, 46);

  const centralOffset = local.length + outerName.length + compressed.length;
  const baseSize = centralOffset + central.length + 22;
  const commentSize = Math.max(0, targetArchiveBytes - baseSize);
  const comment = Buffer.alloc(commentSize, 0x44);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(comment.length, 20);
  eocd.set(comment, 22);
  return Buffer.concat([local, outerName, compressed, central, eocd]);
}

async function main() {
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(temporaryGzip, { force: true });
  rmSync(temporaryDeflate, { force: true });
  const zeroCrc = await crcOfZeros();
  await pipeline(Readable.from(zeros()), createDeflateRaw({ level: 9 }), createWriteStream(temporaryDeflate));
  const compressedZeros = readFileSync(temporaryDeflate);
  const innerBytes = Readable.from(innerArchive(zeroCrc, compressedZeros));
  await pipeline(innerBytes, createGzip({ level: 9, mtime: 0 }), createWriteStream(temporaryGzip));
  const gzipBytes = readFileSync(temporaryGzip);
  if (gzipBytes.length < 18 || gzipBytes.readUInt16LE(0) !== 0x8b1f || gzipBytes[3] !== 0) {
    throw new Error('Unexpected gzip wrapper while generating the ZIP fixture.');
  }
  const gzipCrc = gzipBytes.readUInt32LE(gzipBytes.length - 8);
  const innerSize = gzipBytes.readUInt32LE(gzipBytes.length - 4);
  const rawDeflate = gzipBytes.subarray(10, gzipBytes.length - 8);
  const output = outerArchive(rawDeflate, innerSize, gzipCrc);
  const innerLocalSize = 30 + innerName.length + 12;
  const innerTailSize = 46 + innerName.length + 12 + 56 + 20 + 22;
  const expectedInnerSize = innerLocalSize + compressedZeros.length + innerTailSize;
  if (innerSize !== expectedInnerSize || statSync(temporaryGzip).size !== gzipBytes.length) {
    throw new Error(`Generated nested ZIP size mismatch: gzip=${innerSize}, expected=${expectedInnerSize}, deflate=${compressedZeros.length}.`);
  }
  writeFileSync(destination, output);
  rmSync(temporaryGzip, { force: true });
  rmSync(temporaryDeflate, { force: true });
  process.stdout.write(
    `${JSON.stringify({ file: destination, innerDeflatedZeroBytes: zeroBytes, innerZipBytes: innerSize, innerDeflateBytes: compressedZeros.length, outerCompressedBytes: rawDeflate.length, outerArchiveBytes: output.length, innerZeroCrc32: zeroCrc, outerInnerZipCrc32: gzipCrc })}\n`,
  );
}

await main();

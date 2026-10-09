import { deflateSync } from 'fflate';

export interface ZipFixtureEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  declaredSize?: number;
  zip64Compressed?: boolean;
  zip64DiskStart?: number;
  dataDescriptor?: boolean;
  descriptorSignature?: boolean;
}

export interface ZipFixtureOptions {
  zip64?: boolean;
}

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);
for (let value = 0; value < crcTable.length; value += 1) {
  let remainder = value;
  for (let bit = 0; bit < 8; bit += 1)
    remainder = (remainder & 1) !== 0 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  crcTable[value] = remainder >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Small ZIP writer for legal, in-memory test fixtures. It is never shipped. */
export function makeZip(items: readonly ZipFixtureEntry[], options: ZipFixtureOptions = {}): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localSize = 0;

  for (const item of items) {
    const name = encoder.encode(item.name);
    const method = item.method ?? 0;
    const compressed = method === 8 ? deflateSync(item.data) : item.data;
    const flags = item.flags ?? 0x0800 | (item.dataDescriptor ? 1 << 3 : 0);
    const declaredSize = item.declaredSize ?? item.data.length;
    const wideUncompressed = declaredSize > 0xffffffff;
    const wideCompressed = item.zip64Compressed ?? false;
    const checksum = crc32(item.data);
    const zip64SizeCount = Number(wideUncompressed) + Number(wideCompressed);
    const localExtraLength = zip64SizeCount === 0 ? 0 : 4 + 8 * zip64SizeCount;
    const local = new Uint8Array(30 + name.length + localExtraLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, item.dataDescriptor ? 0 : checksum, true);
    localView.setUint32(18, item.dataDescriptor ? 0 : wideCompressed ? 0xffffffff : compressed.length, true);
    localView.setUint32(22, item.dataDescriptor ? 0 : wideUncompressed ? 0xffffffff : declaredSize, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, localExtraLength, true);
    local.set(name, 30);
    if (zip64SizeCount > 0) {
      localView.setUint16(30 + name.length, 0x0001, true);
      localView.setUint16(32 + name.length, 8 * zip64SizeCount, true);
      let extraOffset = 34 + name.length;
      if (wideUncompressed) {
        localView.setBigUint64(extraOffset, BigInt(declaredSize), true);
        extraOffset += 8;
      }
      if (wideCompressed) localView.setBigUint64(extraOffset, BigInt(compressed.length), true);
    }
    localParts.push(local, compressed);
    if (item.dataDescriptor) {
      const signature = item.descriptorSignature ?? true;
      const descriptor = new Uint8Array((signature ? 4 : 0) + 12);
      const descriptorView = new DataView(descriptor.buffer);
      let descriptorOffset = 0;
      if (signature) {
        descriptorView.setUint32(descriptorOffset, 0x08074b50, true);
        descriptorOffset += 4;
      }
      descriptorView.setUint32(descriptorOffset, checksum, true);
      descriptorView.setUint32(descriptorOffset + 4, compressed.length, true);
      descriptorView.setUint32(descriptorOffset + 8, declaredSize, true);
      localParts.push(descriptor);
    }

    const hasWideDisk = item.zip64DiskStart !== undefined;
    const centralZip64SizeCount = Number(wideUncompressed) + Number(wideCompressed);
    const centralExtraPayloadLength = 8 * centralZip64SizeCount + (hasWideDisk ? 4 : 0);
    const centralExtraLength = centralExtraPayloadLength === 0 ? 0 : 4 + centralExtraPayloadLength;
    const central = new Uint8Array(46 + name.length + centralExtraLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, wideCompressed ? 0xffffffff : compressed.length, true);
    centralView.setUint32(24, wideUncompressed ? 0xffffffff : declaredSize, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint16(30, centralExtraLength, true);
    if (hasWideDisk) centralView.setUint16(34, 0xffff, true);
    centralView.setUint32(42, localSize, true);
    central.set(name, 46);
    if (centralExtraLength > 0) {
      centralView.setUint16(46 + name.length, 0x0001, true);
      centralView.setUint16(48 + name.length, centralExtraPayloadLength, true);
      let extraOffset = 50 + name.length;
      if (wideUncompressed) {
        centralView.setBigUint64(extraOffset, BigInt(declaredSize), true);
        extraOffset += 8;
      }
      if (wideCompressed) {
        centralView.setBigUint64(extraOffset, BigInt(compressed.length), true);
        extraOffset += 8;
      }
      if (hasWideDisk) centralView.setUint32(extraOffset, item.zip64DiskStart!, true);
    }
    centralParts.push(central);
    localSize += localParts.slice(-(item.dataDescriptor ? 3 : 2)).reduce((sum, part) => sum + part.length, 0);
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralOffset = localSize;
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  let tailParts: Uint8Array[] = [];
  if (options.zip64) {
    const recordAt = localSize + centralSize;
    const record = new Uint8Array(56);
    const recordView = new DataView(record.buffer);
    recordView.setUint32(0, 0x06064b50, true);
    recordView.setBigUint64(4, 44n, true);
    recordView.setUint16(12, 45, true);
    recordView.setUint16(14, 45, true);
    recordView.setBigUint64(24, BigInt(items.length), true);
    recordView.setBigUint64(32, BigInt(items.length), true);
    recordView.setBigUint64(40, BigInt(centralSize), true);
    recordView.setBigUint64(48, BigInt(centralOffset), true);
    const locator = new Uint8Array(20);
    const locatorView = new DataView(locator.buffer);
    locatorView.setUint32(0, 0x07064b50, true);
    locatorView.setBigUint64(8, BigInt(recordAt), true);
    locatorView.setUint32(16, 1, true);
    view.setUint16(8, 0xffff, true);
    view.setUint16(10, 0xffff, true);
    view.setUint32(12, 0xffffffff, true);
    view.setUint32(16, 0xffffffff, true);
    tailParts = [record, locator];
  } else {
    view.setUint16(8, items.length, true);
    view.setUint16(10, items.length, true);
    view.setUint32(12, centralSize, true);
    view.setUint32(16, centralOffset, true);
  }

  const tailSize = tailParts.reduce((sum, part) => sum + part.length, 0);
  const total = localSize + centralSize + tailSize + eocd.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of localParts) {
    result.set(part, offset);
    offset += part.length;
  }
  for (const part of centralParts) {
    result.set(part, offset);
    offset += part.length;
  }
  for (const part of tailParts) {
    result.set(part, offset);
    offset += part.length;
  }
  result.set(eocd, offset);
  return result;
}

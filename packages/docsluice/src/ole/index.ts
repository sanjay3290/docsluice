import { CorruptFileError } from '../core/errors.js';
import type { Budget } from '../core/budget.js';

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const FREE_SECTOR = 0xffff_ffff;
const END_OF_CHAIN = 0xffff_fffe;
const FAT_SECTOR = 0xffff_fffd;
const DIFAT_SECTOR = 0xffff_fffc;
const NO_STREAM = 0xffff_ffff;
const MINI_SECTOR_SIZE = 64;
const DIRECTORY_ENTRY_SIZE = 128;
const HEADER_DIFAT_COUNT = 109;

export interface CfbEntry {
  path: string;
  size: number;
  type: 'root' | 'storage' | 'stream';
}

export interface CfbArchive {
  readonly entries: readonly CfbEntry[];
  /** Return a stream's bytes. Repeated calls consume the shared uncompressed-byte budget again. */
  read(path: string): Uint8Array;
}

interface DirectoryEntry {
  name: string;
  type: 1 | 2 | 5;
  left: number;
  right: number;
  child: number;
  startSector: number;
  claimedSize: bigint;
}

interface StreamInfo {
  chain: number[];
  size: number;
  mini: boolean;
}

/**
 * Open the supported CFB profile synchronously. Only 512-byte (version 3) and
 * 4096-byte (version 4) sectors are accepted. Stream sizes are capped by their
 * reachable chain capacity, and stream output is charged to the shared budget.
 */
export function openCfb(bytes: Uint8Array, budget: Budget): CfbArchive {
  budget.tick();
  const headerView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 512 || SIGNATURE.some((value, index) => bytes[index] !== value)) {
    throw corrupt();
  }

  const majorVersion = headerView.getUint16(26, true);
  if (headerView.getUint16(28, true) !== 0xfffe || headerView.getUint16(32, true) !== 6) {
    throw corrupt();
  }
  const sectorShift = headerView.getUint16(30, true);
  const sectorSize = sectorShift === 9 ? 512 : sectorShift === 12 ? 4096 : 0;
  if (
    (majorVersion !== 3 && majorVersion !== 4) ||
    sectorSize === 0 ||
    (majorVersion === 3 && sectorSize !== 512) ||
    (majorVersion === 4 && sectorSize !== 4096) ||
    bytes.byteLength < sectorSize
  ) {
    throw corrupt();
  }

  const sectorCount = Math.floor(bytes.byteLength / sectorSize) - 1;
  const numFatSectors = headerView.getUint32(44, true);
  const firstDirectorySector = headerView.getUint32(48, true);
  const miniStreamCutoff = headerView.getUint32(56, true);
  const firstMiniFatSector = headerView.getUint32(60, true);
  const numMiniFatSectors = headerView.getUint32(64, true);
  const firstDifatSector = headerView.getUint32(68, true);
  const numDifatSectors = headerView.getUint32(72, true);
  if (
    numFatSectors === 0 ||
    numFatSectors > sectorCount ||
    miniStreamCutoff !== 4096 ||
    numMiniFatSectors > sectorCount ||
    numDifatSectors > sectorCount ||
    firstDirectorySector >= sectorCount
  ) {
    throw corrupt();
  }

  const sectorBytes = (sectorId: number): Uint8Array => {
    if (!Number.isSafeInteger(sectorId) || sectorId < 0 || sectorId >= sectorCount) throw corrupt();
    const offset = (sectorId + 1) * sectorSize;
    return bytes.subarray(offset, offset + sectorSize);
  };
  const sectorView = (sectorId: number): DataView => {
    const chunk = sectorBytes(sectorId);
    return new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  };

  const fatSectorIds: number[] = [];
  const seenFatSectors = new Set<number>();
  const appendFatSector = (sectorId: number): void => {
    if (sectorId === FREE_SECTOR) return;
    if (sectorId >= sectorCount || seenFatSectors.has(sectorId)) throw corrupt();
    seenFatSectors.add(sectorId);
    fatSectorIds.push(sectorId);
  };
  for (let index = 0; index < HEADER_DIFAT_COUNT && fatSectorIds.length < numFatSectors; index++) {
    budget.tick();
    appendFatSector(headerView.getUint32(76 + index * 4, true));
  }

  const seenDifatSectors = new Set<number>();
  let difatSector = firstDifatSector;
  for (let count = 0; count < numDifatSectors; count++) {
    budget.tick();
    if (difatSector >= sectorCount || seenDifatSectors.has(difatSector)) throw corrupt();
    seenDifatSectors.add(difatSector);
    const difat = sectorView(difatSector);
    for (let index = 0; index < sectorSize / 4 - 1 && fatSectorIds.length < numFatSectors; index++) {
      budget.tick();
      appendFatSector(difat.getUint32(index * 4, true));
    }
    difatSector = difat.getUint32(sectorSize - 4, true);
  }
  if (fatSectorIds.length !== numFatSectors) throw corrupt();
  if (
    (numDifatSectors === 0 && firstDifatSector !== END_OF_CHAIN) ||
    (numDifatSectors > 0 && difatSector !== END_OF_CHAIN)
  ) {
    throw corrupt();
  }
  const claimedSectors = new Set<number>();
  for (const sectorId of fatSectorIds) {
    budget.tick();
    claimedSectors.add(sectorId);
  }
  for (const sectorId of seenDifatSectors) {
    budget.tick();
    if (claimedSectors.has(sectorId)) throw corrupt();
    claimedSectors.add(sectorId);
  }
  const claimSectorChain = (chain: readonly number[]): void => {
    for (const sectorId of chain) {
      budget.tick();
      if (claimedSectors.has(sectorId)) throw corrupt();
      claimedSectors.add(sectorId);
    }
  };

  const fat: number[] = [];
  for (const fatSectorId of fatSectorIds) {
    const view = sectorView(fatSectorId);
    for (let offset = 0; offset < sectorSize; offset += 4) {
      budget.tick();
      fat.push(view.getUint32(offset, true));
    }
  }

  const followChain = (startSector: number, allocation: readonly number[], mini = false): number[] => {
    if (startSector === END_OF_CHAIN || startSector === FREE_SECTOR) return [];
    const chain: number[] = [];
    const seen = new Set<number>();
    let sectorId = startSector;
    const maximum = mini ? Math.floor(bytes.byteLength / MINI_SECTOR_SIZE) : sectorCount;
    while (sectorId !== END_OF_CHAIN) {
      budget.tick();
      if (sectorId >= maximum || seen.has(sectorId) || sectorId >= allocation.length) throw corrupt();
      seen.add(sectorId);
      chain.push(sectorId);
      if (chain.length > maximum) throw corrupt();
      sectorId = allocation[sectorId]!;
      if (sectorId === FREE_SECTOR || sectorId === FAT_SECTOR || sectorId === DIFAT_SECTOR) throw corrupt();
    }
    return chain;
  };

  const directoryChain = followChain(firstDirectorySector, fat);
  if (directoryChain.length === 0) throw corrupt();
  claimSectorChain(directoryChain);
  if (majorVersion === 4 && directoryChain.length !== headerView.getUint32(40, true)) throw corrupt();
  const directorySlotCount = (directoryChain.length * sectorSize) / DIRECTORY_ENTRY_SIZE;
  if (!budget.addEntries(Math.max(0, directorySlotCount - 1))) {
    return {
      entries: [{ path: '', size: 0, type: 'root' }],
      read: () => {
        throw new RangeError('Unknown CFB stream path.');
      },
    };
  }
  const directoryByteLength = directoryChain.length * sectorSize;
  const directoryBytes = new Uint8Array(directoryByteLength);
  for (let index = 0; index < directoryChain.length; index++) {
    budget.tick();
    directoryBytes.set(sectorBytes(directoryChain[index]!), index * sectorSize);
  }
  const directoryView = new DataView(directoryBytes.buffer);
  const directoryCount = Math.floor(directoryByteLength / DIRECTORY_ENTRY_SIZE);
  const directory: Array<DirectoryEntry | undefined> = Array.from(
    { length: directoryCount },
    () => undefined,
  );
  const decoder = new TextDecoder('utf-16le');
  for (let index = 0; index < directoryCount; index++) {
    budget.tick();
    const offset = index * DIRECTORY_ENTRY_SIZE;
    const typeValue = directoryView.getUint8(offset + 66);
    if (typeValue === 0) continue;
    if (typeValue !== 1 && typeValue !== 2 && typeValue !== 5) throw corrupt();
    const nameLength = directoryView.getUint16(offset + 64, true);
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) throw corrupt();
    let name = decoder.decode(directoryBytes.subarray(offset, offset + nameLength - 2));
    name = name.replaceAll('\u0000', '');
    const lowSize = directoryView.getUint32(offset + 120, true);
    const highSize = majorVersion === 4 ? directoryView.getUint32(offset + 124, true) : 0;
    directory[index] = {
      name,
      type: typeValue,
      left: directoryView.getUint32(offset + 68, true),
      right: directoryView.getUint32(offset + 72, true),
      child: directoryView.getUint32(offset + 76, true),
      startSector: directoryView.getUint32(offset + 116, true),
      claimedSize: (BigInt(highSize) << 32n) | BigInt(lowSize),
    };
  }
  const root = directory[0];
  if (!root || root.type !== 5) throw corrupt();

  const miniFat: number[] = [];
  if (numMiniFatSectors > 0) {
    if (firstMiniFatSector >= sectorCount) throw corrupt();
    const miniFatChain = followChain(firstMiniFatSector, fat);
    if (miniFatChain.length !== numMiniFatSectors) throw corrupt();
    claimSectorChain(miniFatChain);
    for (const miniFatSectorId of miniFatChain) {
      const view = sectorView(miniFatSectorId);
      for (let offset = 0; offset < sectorSize; offset += 4) {
        budget.tick();
        miniFat.push(view.getUint32(offset, true));
      }
    }
  } else if (firstMiniFatSector !== END_OF_CHAIN) {
    throw corrupt();
  }

  const rootChain = followChain(root.startSector, fat);
  claimSectorChain(rootChain);
  const rootChainCapacity = rootChain.length * sectorSize;
  const rootSize = safeBound(root.claimedSize, rootChainCapacity);
  let miniStream = new Uint8Array(0);
  if (rootSize > 0) {
    miniStream = new Uint8Array(rootSize);
    for (let index = 0; index < rootChain.length && index * sectorSize < rootSize; index++) {
      budget.tick();
      const count = Math.min(sectorSize, rootSize - index * sectorSize);
      miniStream.set(sectorBytes(rootChain[index]!).subarray(0, count), index * sectorSize);
    }
  }

  const entries: CfbEntry[] = [{ path: '', size: 0, type: 'root' }];
  const seenPaths = new Set<string>(['']);
  const streams = new Map<string, StreamInfo>();
  const claimedMiniSectors = new Set<number>();
  const visitedDirectoryIds = new Set<number>([0]);
  type WalkFrame =
    | { kind: 'visit'; index: number; parentPath: string }
    | { kind: 'emit'; index: number; parentPath: string }
    | { kind: 'exitDepth' };
  const stack: WalkFrame[] = [];
  let activeBlockDepths = 0;
  const enterBlockDepth = (): boolean => {
    let entered: boolean;
    try {
      entered = budget.enterDepth('block');
    } catch (error) {
      budget.exitDepth('block');
      throw error;
    }
    if (!entered) {
      budget.exitDepth('block');
      return false;
    }
    activeBlockDepths++;
    return true;
  };
  const exitBlockDepth = (): void => {
    budget.exitDepth('block');
    activeBlockDepths--;
  };

  try {
    if (root.child !== NO_STREAM && enterBlockDepth()) {
      stack.push({ kind: 'exitDepth' });
      stack.push({ kind: 'visit', index: root.child, parentPath: '' });
    }
    while (stack.length > 0) {
      budget.tick();
      const frame = stack.pop()!;
      if (frame.kind === 'exitDepth') {
        exitBlockDepth();
        continue;
      }
      if (frame.kind === 'visit') {
        if (frame.index >= directory.length || visitedDirectoryIds.has(frame.index)) throw corrupt();
        const node = directory[frame.index];
        if (!node || node.type === 5) throw corrupt();
        visitedDirectoryIds.add(frame.index);
        stack.push({ kind: 'emit', index: frame.index, parentPath: frame.parentPath });
        if (node.left !== NO_STREAM)
          stack.push({ kind: 'visit', index: node.left, parentPath: frame.parentPath });
        continue;
      }

      const node = directory[frame.index]!;
      const path = frame.parentPath === '' ? node.name : `${frame.parentPath}/${node.name}`;
      if (seenPaths.has(path)) throw corrupt();
      seenPaths.add(path);
      if (node.type === 1) {
        entries.push({ path, size: 0, type: 'storage' });
        const entered = node.child !== NO_STREAM && enterBlockDepth();
        if (node.right !== NO_STREAM)
          stack.push({ kind: 'visit', index: node.right, parentPath: frame.parentPath });
        if (entered) {
          stack.push({ kind: 'exitDepth' });
          stack.push({ kind: 'visit', index: node.child, parentPath: path });
        }
        continue;
      }

      const isMini = node.claimedSize < BigInt(miniStreamCutoff);
      const chain = followChain(node.startSector, isMini ? miniFat : fat, isMini);
      if (isMini) {
        for (const miniSectorId of chain) {
          budget.tick();
          if (claimedMiniSectors.has(miniSectorId)) throw corrupt();
          claimedMiniSectors.add(miniSectorId);
          if (miniSectorId * MINI_SECTOR_SIZE >= miniStream.byteLength) throw corrupt();
        }
      } else {
        claimSectorChain(chain);
      }
      const unitSize = isMini ? MINI_SECTOR_SIZE : sectorSize;
      const chainCapacity = chain.length * unitSize;
      let available = chainCapacity;
      if (isMini) available = Math.min(available, miniStream.byteLength);
      const size = safeBound(node.claimedSize, available);
      entries.push({ path, size, type: 'stream' });
      streams.set(path, { chain, size, mini: isMini });
      if (node.right !== NO_STREAM)
        stack.push({ kind: 'visit', index: node.right, parentPath: frame.parentPath });
    }
  } catch (error) {
    while (activeBlockDepths > 0) exitBlockDepth();
    throw error;
  }

  const read = (path: string): Uint8Array => {
    const stream = streams.get(path);
    if (!stream) throw new RangeError('Unknown CFB stream path.');
    const chunks: Uint8Array[] = [];
    let written = 0;
    for (const sectorId of stream.chain) {
      budget.tick();
      if (written >= stream.size) break;
      const source = stream.mini
        ? miniStream.subarray(sectorId * MINI_SECTOR_SIZE, (sectorId + 1) * MINI_SECTOR_SIZE)
        : sectorBytes(sectorId);
      const count = Math.min(source.byteLength, stream.size - written);
      if (!budget.addUncompressed(count)) break;
      chunks.push(source.slice(0, count));
      written += count;
    }
    const output = new Uint8Array(written);
    let offset = 0;
    for (const chunk of chunks) {
      budget.tick();
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  };

  return { entries, read };
}

function safeBound(claimed: bigint, available: number): number {
  if (claimed <= 0n) return 0;
  const bounded = claimed < BigInt(available) ? Number(claimed) : available;
  return Number.isSafeInteger(bounded) ? bounded : available;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The compound file structure is invalid.');
}

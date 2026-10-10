import type { Budget } from '../core/budget.js';

const SECTOR_SIZE = 512;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const ENTRIES_PER_SECTOR = SECTOR_SIZE / 4;
const HEADER_DIFAT_COUNT = 109;
const FREE_SECTOR = 0xffff_ffff;
const END_OF_CHAIN = 0xffff_fffe;
const FAT_SECTOR = 0xffff_fffd;
const DIFAT_SECTOR = 0xffff_fffc;
const NO_STREAM = 0xffff_ffff;
const MAX_NAME_LENGTH = 31;

/** One storage or stream for {@link writeCfb}. A parent storage is listed before its children. */
export interface CfbWriteEntry {
  /** Slash-separated path below the root, for example `__attach_version1.0_#00000000/__substg1.0_3707001F`. */
  readonly path: string;
  readonly type: 'storage' | 'stream';
  readonly data?: Uint8Array;
}

interface Node {
  name: string;
  type: 1 | 2 | 5;
  data: Uint8Array;
  start: number;
  size: number;
  left: number;
  right: number;
  child: number;
}

/** CFB sibling order ([MS-CFB] 2.6.4): shorter names first, then upper-cased code units. */
function compareNames(left: string, right: string): number {
  if (left.length !== right.length) return left.length - right.length;
  const a = left.toUpperCase();
  const b = right.toUpperCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Write storages and streams as a version 3 compound file (512-byte sectors, 64-byte mini sectors
 * below 4096 bytes). Used to hand an embedded storage to the child pipeline as a file of its own.
 * Returns `undefined` for an entry list that cannot form a valid tree, or when the output would
 * pass the shared uncompressed-byte limit; the output size is charged to that limit.
 */
export function writeCfb(entries: readonly CfbWriteEntry[], budget: Budget): Uint8Array | undefined {
  budget.tick();
  const nodes: Node[] = [
    {
      name: 'Root Entry',
      type: 5,
      data: new Uint8Array(0),
      start: END_OF_CHAIN,
      size: 0,
      left: NO_STREAM,
      right: NO_STREAM,
      child: NO_STREAM,
    },
  ];
  const ids = new Map<string, number>([['', 0]]);
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    budget.tick();
    const slash = entry.path.lastIndexOf('/');
    const parent = ids.get(slash < 0 ? '' : entry.path.slice(0, slash));
    const name = entry.path.slice(slash + 1);
    if (parent === undefined || nodes[parent]!.type === 2 || ids.has(entry.path)) return undefined;
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) return undefined;
    const data = entry.type === 'stream' ? (entry.data ?? new Uint8Array(0)) : new Uint8Array(0);
    const id = nodes.length;
    nodes.push({
      name,
      type: entry.type === 'stream' ? 2 : 1,
      data,
      start: END_OF_CHAIN,
      size: data.length,
      left: NO_STREAM,
      right: NO_STREAM,
      child: NO_STREAM,
    });
    ids.set(entry.path, id);
    const siblings = children.get(parent);
    if (siblings) siblings.push(id);
    else children.set(parent, [id]);
  }

  // Each storage's children form a balanced binary tree; an explicit stack, never recursion.
  for (const [parent, siblings] of children) {
    budget.tick();
    siblings.sort((left, right) => compareNames(nodes[left]!.name, nodes[right]!.name));
    const work: Array<{ start: number; end: number; link: (id: number) => void }> = [
      { start: 0, end: siblings.length, link: (id) => (nodes[parent]!.child = id) },
    ];
    while (work.length > 0) {
      budget.tick();
      const range = work.pop()!;
      if (range.start >= range.end) continue;
      const middle = range.start + ((range.end - range.start) >>> 1);
      const id = siblings[middle]!;
      range.link(id);
      work.push({ start: range.start, end: middle, link: (child) => (nodes[id]!.left = child) });
      work.push({ start: middle + 1, end: range.end, link: (child) => (nodes[id]!.right = child) });
    }
  }

  // Plan the mini stream and the regular sector counts.
  let miniSectors = 0;
  let regularSectors = 0;
  for (const node of nodes) {
    budget.tick();
    if (node.type !== 2 || node.size === 0) continue;
    if (node.size < MINI_STREAM_CUTOFF) {
      node.start = miniSectors;
      miniSectors += Math.ceil(node.size / MINI_SECTOR_SIZE);
    } else regularSectors += Math.ceil(node.size / SECTOR_SIZE);
  }
  const miniStreamBytes = miniSectors * MINI_SECTOR_SIZE;
  const miniStreamSectors = Math.ceil(miniStreamBytes / SECTOR_SIZE);
  const miniFatSectors = Math.ceil(miniSectors / ENTRIES_PER_SECTOR);
  const directorySectors = Math.ceil((nodes.length * 128) / SECTOR_SIZE);
  const dataSectors = regularSectors + miniStreamSectors + miniFatSectors + directorySectors;
  let fatSectors = 1;
  let difatSectors = 0;
  for (;;) {
    budget.tick();
    const neededDifat = Math.max(0, Math.ceil((fatSectors - HEADER_DIFAT_COUNT) / (ENTRIES_PER_SECTOR - 1)));
    const neededFat = Math.ceil((dataSectors + fatSectors + neededDifat) / ENTRIES_PER_SECTOR);
    if (neededFat <= fatSectors && neededDifat === difatSectors) break;
    fatSectors = Math.max(fatSectors, neededFat);
    difatSectors = neededDifat;
  }
  const sectorCount = dataSectors + fatSectors + difatSectors;
  const fileSize = (sectorCount + 1) * SECTOR_SIZE;
  if (!Number.isSafeInteger(fileSize) || !budget.checkUncompressed(fileSize)) return undefined;
  if (!budget.addUncompressed(fileSize)) return undefined;

  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  const fat = new Uint32Array(fatSectors * ENTRIES_PER_SECTOR).fill(FREE_SECTOR);
  let next = 0;
  const allocate = (count: number): number => {
    if (count === 0) return END_OF_CHAIN;
    const start = next;
    for (let index = 0; index < count; index++) {
      budget.tick();
      fat[next] = index + 1 < count ? next + 1 : END_OF_CHAIN;
      next++;
    }
    return start;
  };
  const sectorOffset = (sector: number) => (sector + 1) * SECTOR_SIZE;

  const miniStreamStart = allocate(miniStreamSectors);
  const miniFat = new Uint32Array(miniFatSectors * ENTRIES_PER_SECTOR).fill(FREE_SECTOR);
  for (const node of nodes) {
    budget.tick();
    if (node.type !== 2 || node.size === 0) continue;
    if (node.size < MINI_STREAM_CUTOFF) {
      const count = Math.ceil(node.size / MINI_SECTOR_SIZE);
      for (let index = 0; index < count; index++) {
        budget.tick();
        miniFat[node.start + index] = index + 1 < count ? node.start + index + 1 : END_OF_CHAIN;
      }
      bytes.set(node.data, sectorOffset(miniStreamStart) + node.start * MINI_SECTOR_SIZE);
    } else {
      node.start = allocate(Math.ceil(node.size / SECTOR_SIZE));
      // Regular chains are allocated contiguously, so one copy places the whole stream.
      bytes.set(node.data, sectorOffset(node.start));
    }
  }
  const root = nodes[0]!;
  root.start = miniStreamStart;
  root.size = miniStreamBytes;
  const miniFatStart = allocate(miniFatSectors);
  for (let index = 0; index < miniFat.length; index++) {
    budget.tick();
    view.setUint32(sectorOffset(miniFatStart) + index * 4, miniFat[index]!, true);
  }
  const directoryStart = allocate(directorySectors);
  for (let id = 0; id < directorySectors * (SECTOR_SIZE / 128); id++) {
    budget.tick();
    const offset = sectorOffset(directoryStart) + id * 128;
    const node = nodes[id];
    view.setUint32(offset + 68, NO_STREAM, true);
    view.setUint32(offset + 72, NO_STREAM, true);
    view.setUint32(offset + 76, NO_STREAM, true);
    if (!node) continue;
    for (let char = 0; char < node.name.length; char++) {
      budget.tick();
      view.setUint16(offset + char * 2, node.name.charCodeAt(char), true);
    }
    view.setUint16(offset + 64, (node.name.length + 1) * 2, true);
    bytes[offset + 66] = node.type;
    bytes[offset + 67] = 1;
    view.setUint32(offset + 68, node.left, true);
    view.setUint32(offset + 72, node.right, true);
    view.setUint32(offset + 76, node.child, true);
    view.setUint32(offset + 116, node.type === 1 ? 0 : node.start, true);
    view.setUint32(offset + 120, node.size, true);
  }
  const fatStart = next;
  for (let index = 0; index < fatSectors; index++) fat[next++] = FAT_SECTOR;
  const difatStart = next;
  for (let index = 0; index < difatSectors; index++) fat[next++] = DIFAT_SECTOR;

  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, directoryStart, true);
  view.setUint32(56, MINI_STREAM_CUTOFF, true);
  view.setUint32(60, miniFatSectors > 0 ? miniFatStart : END_OF_CHAIN, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, difatSectors > 0 ? difatStart : END_OF_CHAIN, true);
  view.setUint32(72, difatSectors, true);
  for (let index = 0; index < HEADER_DIFAT_COUNT; index++) {
    view.setUint32(76 + index * 4, index < fatSectors ? fatStart + index : FREE_SECTOR, true);
  }
  for (let index = 0; index < difatSectors; index++) {
    budget.tick();
    const offset = sectorOffset(difatStart + index);
    for (let slot = 0; slot < ENTRIES_PER_SECTOR - 1; slot++) {
      const fatIndex = HEADER_DIFAT_COUNT + index * (ENTRIES_PER_SECTOR - 1) + slot;
      view.setUint32(offset + slot * 4, fatIndex < fatSectors ? fatStart + fatIndex : FREE_SECTOR, true);
    }
    view.setUint32(
      offset + SECTOR_SIZE - 4,
      index + 1 < difatSectors ? difatStart + index + 1 : END_OF_CHAIN,
      true,
    );
  }
  for (let index = 0; index < fat.length; index++) {
    if ((index & 0xff) === 0) budget.tick();
    view.setUint32(sectorOffset(fatStart) + index * 4, fat[index]!, true);
  }
  return bytes;
}

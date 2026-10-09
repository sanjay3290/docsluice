import type { Cell } from '../../core/model.js';
import { CorruptFileError } from '../../core/errors.js';
import type { Budget } from '../../core/budget.js';
import type { CfbArchive } from '../../ole/index.js';
import { openCfb } from '../../ole/index.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { emitHtml } from '../../html/index.js';
import { parseHeaders } from '../../mime/index.js';
import { deencapsulateRtfHtml, rtfReader } from '../rtf/index.js';

const MIME = 'application/vnd.ms-outlook';
const LZFU = 0x75465a4c;
const MELA = 0x414c454d;
const DICTIONARY_SIZE = 4096;
const DICTIONARY_START = 207;
const INITIAL_DICTIONARY =
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

interface IndexedArchive {
  cfb: CfbArchive;
  entries: CfbArchive['entries'];
  streams: Map<string, CfbArchive['entries'][number]>;
}

function indexArchive(ctx: ReadContext, cfb: CfbArchive): IndexedArchive {
  const streams = new Map<string, CfbArchive['entries'][number]>();
  for (const entry of cfb.entries) {
    ctx.budget.tick();
    if (entry.type === 'stream') streams.set(entry.path, entry);
  }
  return { cfb, entries: cfb.entries, streams };
}

function warn(ctx: ReadContext, message: string): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message });
}

function decodePropertyString(
  ctx: ReadContext,
  archive: IndexedArchive,
  propertyPath: string,
  codePage: number,
  budget: Budget,
): string | undefined {
  const unicodePath = `${propertyPath}001F`;
  const ansiPath = `${propertyPath}001E`;
  let text: string | undefined;
  const unicode = stream(archive, unicodePath);
  const ansi = unicode ? undefined : stream(archive, ansiPath);
  if (unicode) {
    const bytes = unicode;
    const evenLength = bytes.length & ~1;
    text = new TextDecoder('utf-16le').decode(bytes.subarray(0, evenLength));
  } else if (ansi) {
    const bytes = ansi;
    let encoding = codePageName(codePage);
    if (!encoding) {
      encoding = 'windows-1252';
      warnOnce(ctx, 'ENCODING_GUESSED', 'An unsupported MSG code page was replaced with Windows-1252.');
    }
    try {
      text = new TextDecoder(encoding).decode(bytes);
    } catch {
      text = new TextDecoder('windows-1252').decode(bytes);
      warnOnce(ctx, 'ENCODING_GUESSED', 'An unsupported MSG code page was replaced with Windows-1252.');
    }
  }
  if (text === undefined) return undefined;
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 0) {
    budget.tick();
    end--;
  }
  return text.slice(0, end);
}

function warnOnce(ctx: ReadContext, code: 'ENCODING_GUESSED', message: string): void {
  const present = ctx.warnings.warnings.some((warning) => warning.code === code);
  if (!present) ctx.warnings.add({ code, message });
}

function decodeHtml(ctx: ReadContext, bytes: Uint8Array, codePage: number): string {
  const encoding = codePageName(codePage);
  if (!encoding) {
    warnOnce(ctx, 'ENCODING_GUESSED', 'An unsupported MSG code page was replaced with Windows-1252.');
    return new TextDecoder('windows-1252').decode(bytes);
  }
  try {
    return new TextDecoder(encoding).decode(bytes);
  } catch {
    warnOnce(ctx, 'ENCODING_GUESSED', 'An unsupported MSG code page was replaced with Windows-1252.');
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function codePageName(codePage: number): string | undefined {
  if (codePage === 65001) return 'utf-8';
  if (codePage === 932) return 'shift_jis';
  if (codePage === 936) return 'gbk';
  if (codePage === 949) return 'euc-kr';
  if (codePage === 950) return 'big5';
  if (codePage === 874) return 'windows-874';
  if (codePage >= 1250 && codePage <= 1258) return `windows-${codePage}`;
  if (codePage === 437) return 'ibm437';
  if (codePage === 850) return 'ibm850';
  return undefined;
}

function decodeHeader(ctx: ReadContext, value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = parseHeaders(`X-MSG-Header: ${value}`, ctx.budget);
  return (
    parsed
      .get('x-msg-header')
      ?.replace(/[\t ]+/g, ' ')
      .trim() || undefined
  );
}

function stream(archive: IndexedArchive, path: string): Uint8Array | undefined {
  return archive.streams.has(path) ? archive.cfb.read(path) : undefined;
}

function propertyValue(
  ctx: ReadContext,
  archive: IndexedArchive,
  propertyId: number,
  propertyType: number,
  storage = '',
): Uint8Array | undefined {
  const path = storage ? `${storage}/__properties_version1.0` : '__properties_version1.0';
  const bytes = stream(archive, path);
  const headerSize = !storage
    ? 32
    : /^__(?:recip|attach)_version1\.0_#[^/]+$/.test(storage)
      ? 8
      : storage.endsWith('/__substg1.0_3701000D')
        ? 24
        : 32;
  if (!bytes || bytes.length < headerSize) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = headerSize; offset + 16 <= bytes.length; offset += 16) {
    ctx.budget.tick();
    // The stored property tag is a DWORD: type occupies the low word, then id.
    if (view.getUint16(offset, true) === propertyType && view.getUint16(offset + 2, true) === propertyId)
      return bytes.subarray(offset + 8, offset + 16);
  }
  return undefined;
}

function propertyLong(
  ctx: ReadContext,
  archive: IndexedArchive,
  propertyId: number,
  storage = '',
): number | undefined {
  const bytes = propertyValue(ctx, archive, propertyId, 0x0003, storage);
  return bytes
    ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true)
    : undefined;
}

function decodeFileTime(bytes: Uint8Array | undefined): string | undefined {
  if (!bytes || bytes.length < 8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ticks = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
  const milliseconds = Number(ticks / 10000n - 11644473600000n);
  if (!Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) return undefined;
  return new Date(milliseconds).toISOString();
}

function emitPlain(ctx: ReadContext, value: string): void {
  let start = 0;
  while (start < value.length) {
    ctx.budget.tick();
    let end = start;
    while (end < value.length && value[end] !== '\n' && value[end] !== '\r') {
      ctx.budget.tick();
      end++;
    }
    const text = value.slice(start, end).trim();
    if (text && !ctx.out.paragraph(text, ctx.path ? { path: ctx.path } : {})) return;
    start = end;
    while (start < value.length && (value[start] === '\n' || value[start] === '\r')) {
      ctx.budget.tick();
      start++;
    }
  }
}

function safeAttachmentName(value: string | undefined, budget: Budget): string {
  if (!value) return 'attachment';
  let result = '';
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    const char = value[index]!;
    result += code < 0x20 || code === 0x7f || char === '/' || char === '\\' ? '_' : char;
  }
  let start = 0;
  let end = result.length;
  while (start < end && (result[start] === '.' || result[start] === ' ')) {
    budget.tick();
    start++;
  }
  while (end > start && (result[end - 1] === '.' || result[end - 1] === ' ')) {
    budget.tick();
    end--;
  }
  return start < end ? result.slice(start, end) : 'attachment';
}

async function readAttachments(ctx: ReadContext, archive: IndexedArchive, codePage: number): Promise<void> {
  const attachmentStorages = new Map<string, { embedded: boolean; objectStorage?: string }>();
  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (entry.type !== 'storage') continue;
    const match = /^(__attach_version1\.0_#[^/]+)$/.exec(entry.path);
    if (match) {
      const storage = match[1];
      if (!storage) continue;
      const method = propertyLong(ctx, archive, 0x3705, storage);
      attachmentStorages.set(storage, { embedded: method === 5 });
    }
  }
  if (attachmentStorages.size === 0) return;

  for (const entry of archive.entries) {
    ctx.budget.tick();
    const slash = entry.path.indexOf('/');
    if (slash < 0) continue;
    const attachment = attachmentStorages.get(entry.path.slice(0, slash));
    if (!attachment) continue;
    const rest = entry.path.slice(slash + 1);
    if (entry.type === 'storage' && rest === '__substg1.0_3701000D') {
      attachment.embedded = true;
      attachment.objectStorage = entry.path;
    }
  }

  let found = false;
  for (const [storage, attachment] of attachmentStorages) {
    ctx.budget.tick();
    if (attachment.embedded) {
      found = true;
      const name = safeAttachmentName(
        decodePropertyString(ctx, archive, `${storage}/__substg1.0_3707`, codePage, ctx.budget) ??
          decodePropertyString(ctx, archive, `${storage}/__substg1.0_3704`, codePage, ctx.budget),
        ctx.budget,
      );
      const embedded = attachment.objectStorage
        ? rebuildEmbeddedMessage(ctx, archive, attachment.objectStorage)
        : undefined;
      if (embedded) await ctx.extractChild(name, embedded, { mimeType: 'application/vnd.ms-outlook' });
      else warn(ctx, 'An embedded MSG attachment could not be reconstructed within the active limits.');
      continue;
    }
    const name = safeAttachmentName(
      decodePropertyString(ctx, archive, `${storage}/__substg1.0_3707`, codePage, ctx.budget) ??
        decodePropertyString(ctx, archive, `${storage}/__substg1.0_3704`, codePage, ctx.budget),
      ctx.budget,
    );
    const dataPath = `${storage}/__substg1.0_37010102`;
    const data = stream(archive, dataPath);
    if (!data) {
      found = true;
      warn(ctx, 'An MSG attachment had no supported binary data stream.');
      continue;
    }
    found = true;
    await ctx.extractChild(name, data, { mimeType: 'application/octet-stream' });
  }
  if (found) ctx.out.setFeature('hasEmbeddedFiles');
}

interface RebuiltDirectoryEntry {
  name: string;
  path: string;
  type: 'root' | 'storage' | 'stream';
  parent: number;
  data?: Uint8Array;
  size: number;
  startSector: number;
  left: number;
  right: number;
  child: number;
}

/** Repack an embedded MSG storage as a fresh, bounded version-3 compound file. */
function rebuildEmbeddedMessage(
  ctx: ReadContext,
  archive: IndexedArchive,
  objectStorage: string,
): Uint8Array | undefined {
  const prefix = `${objectStorage}/`;
  if (!archive.streams.has(`${prefix}__properties_version1.0`)) return undefined;
  const noStream = 0xffff_ffff;
  const endOfChain = 0xffff_fffe;
  const fatSectorMarker = 0xffff_fffd;
  const freeSector = 0xffff_ffff;
  const sectorSize = 512;
  const miniSectorSize = 64;
  const nodes: RebuiltDirectoryEntry[] = [
    {
      name: 'Root Entry',
      path: '',
      type: 'root',
      parent: noStream,
      size: 0,
      startSector: endOfChain,
      left: noStream,
      right: noStream,
      child: noStream,
    },
  ];
  const nodeIds = new Map<string, number>([['', 0]]);
  const children = new Map<number, number[]>();
  const miniFat: number[] = [];
  const miniStreamParts: Uint8Array[] = [];
  const regularStreams: number[] = [];

  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (!entry.path.startsWith(prefix)) continue;
    const path = entry.path.slice(prefix.length);
    if (!path) continue;
    const slash = path.lastIndexOf('/');
    const parentPath = slash < 0 ? '' : path.slice(0, slash);
    const parentId = nodeIds.get(parentPath);
    if (parentId === undefined || nodes[parentId]!.type === 'stream' || nodeIds.has(path)) return undefined;
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!name || name.length > 31) return undefined;
    const node: RebuiltDirectoryEntry = {
      name,
      path,
      type: entry.type,
      parent: parentId,
      size: 0,
      startSector: endOfChain,
      left: noStream,
      right: noStream,
      child: noStream,
    };
    if (entry.type === 'stream') {
      let data = stream(archive, entry.path);
      if (!data) return undefined;
      // An embedded MSG has a 24-byte property-stream header. Promote it to the
      // 32-byte root-message form, preserving its six counter words and inserting
      // the standalone-only reserved word immediately before property entries.
      if (path === '__properties_version1.0') {
        if (data.length < 24) return undefined;
        const promoted = new Uint8Array(data.length + 8);
        promoted.set(data.subarray(0, 24), 0);
        promoted.set(data.subarray(24), 32);
        data = promoted;
      }
      node.data = data;
      node.size = data.length;
      if (data.length > 0 && data.length < 4096) {
        node.startSector = miniFat.length;
        const count = Math.ceil(data.length / miniSectorSize);
        for (let index = 0; index < count; index++) {
          ctx.budget.tick();
          const miniId = miniFat.length;
          miniFat.push(index + 1 < count ? miniId + 1 : endOfChain);
          const part = new Uint8Array(miniSectorSize);
          const start = index * miniSectorSize;
          part.set(data.subarray(start, Math.min(data.length, start + miniSectorSize)));
          miniStreamParts.push(part);
        }
      } else if (data.length >= 4096) regularStreams.push(nodes.length);
    }
    const id = nodes.length;
    nodes.push(node);
    nodeIds.set(path, id);
    const list = children.get(parentId) ?? [];
    list.push(id);
    children.set(parentId, list);
  }
  if (nodes.length <= 1) return undefined;

  const compareNames = (leftId: number, rightId: number): number => {
    ctx.budget.tick();
    const left = nodes[leftId]!.name;
    const right = nodes[rightId]!.name;
    if (left.length !== right.length) return left.length - right.length;
    const leftFolded = left.toUpperCase();
    const rightFolded = right.toUpperCase();
    return leftFolded < rightFolded ? -1 : leftFolded > rightFolded ? 1 : 0;
  };
  const linkTree = (ids: number[]): number => {
    if (ids.length === 0) return noStream;
    ids.sort(compareNames);
    let root = noStream;
    const work: Array<{ start: number; end: number; parent: number; side: 'left' | 'right' | 'root' }> = [
      { start: 0, end: ids.length, parent: noStream, side: 'root' },
    ];
    while (work.length > 0) {
      ctx.budget.tick();
      const frame = work.pop()!;
      if (frame.start >= frame.end) continue;
      const middle = frame.start + Math.floor((frame.end - frame.start) / 2);
      const id = ids[middle]!;
      if (frame.side === 'root') root = id;
      else if (frame.side === 'left') nodes[frame.parent]!.left = id;
      else nodes[frame.parent]!.right = id;
      work.push({ start: middle + 1, end: frame.end, parent: id, side: 'right' });
      work.push({ start: frame.start, end: middle, parent: id, side: 'left' });
    }
    return root;
  };
  for (const [parentId, ids] of children) nodes[parentId]!.child = linkTree(ids);

  const directorySectors = Math.max(1, Math.ceil((nodes.length * 128) / sectorSize));
  const miniStreamSize = miniFat.length * miniSectorSize;
  const miniStreamSectors = Math.ceil(miniStreamSize / sectorSize);
  const miniFatSectors = Math.ceil((miniFat.length * 4) / sectorSize);
  const regularSectorCounts = new Map<number, number>();
  let regularSectorTotal = 0;
  for (const id of regularStreams) {
    ctx.budget.tick();
    const count = Math.ceil(nodes[id]!.size / sectorSize);
    regularSectorCounts.set(id, count);
    regularSectorTotal += count;
  }
  const dataSectors = directorySectors + miniStreamSectors + miniFatSectors + regularSectorTotal;
  let fatSectors = Math.max(1, Math.ceil(dataSectors / (sectorSize / 4 - 1)));
  while (Math.ceil((dataSectors + fatSectors) / (sectorSize / 4)) > fatSectors) fatSectors++;
  if (fatSectors > 109) return undefined;
  const sectorCount = dataSectors + fatSectors;
  const fileSize = (sectorCount + 1) * sectorSize;
  if (
    !Number.isSafeInteger(fileSize) ||
    !ctx.budget.checkUncompressed(fileSize) ||
    !ctx.budget.addUncompressed(fileSize)
  )
    return undefined;

  const bytes = new Uint8Array(fileSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(40, 0, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, endOfChain, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, endOfChain, true);
  view.setUint32(64, miniFatSectors, true);
  view.setUint32(68, endOfChain, true);
  view.setUint32(72, 0, true);

  const fatLinks = new Map<number, number>();
  let nextSector = 0;
  const allocateChain = (count: number): number => {
    if (count === 0) return endOfChain;
    const start = nextSector;
    for (let index = 0; index < count; index++) {
      ctx.budget.tick();
      const sectorId = nextSector++;
      fatLinks.set(sectorId, index + 1 < count ? sectorId + 1 : endOfChain);
    }
    return start;
  };
  const regularStarts = new Map<number, number>();
  for (const [id, count] of regularSectorCounts) {
    nodes[id]!.startSector = allocateChain(count);
    regularStarts.set(id, nodes[id]!.startSector);
  }
  const rootMiniStart = allocateChain(miniStreamSectors);
  nodes[0]!.startSector = rootMiniStart;
  nodes[0]!.size = miniStreamSize;
  const miniFatStart = allocateChain(miniFatSectors);
  const directoryStart = allocateChain(directorySectors);
  const fatStarts: number[] = [];
  for (let index = 0; index < fatSectors; index++) {
    ctx.budget.tick();
    const id = nextSector++;
    fatStarts.push(id);
    fatLinks.set(id, fatSectorMarker);
  }
  if (nextSector !== sectorCount) return undefined;
  view.setUint32(48, directoryStart, true);
  view.setUint32(60, miniFatSectors > 0 ? miniFatStart : endOfChain, true);
  for (let index = 0; index < fatStarts.length && index < 109; index++)
    view.setUint32(76 + index * 4, fatStarts[index]!, true);
  for (let index = fatStarts.length; index < 109; index++) view.setUint32(76 + index * 4, freeSector, true);

  const sectorOffset = (sectorId: number) => (sectorId + 1) * sectorSize;
  for (const [id, start] of regularStarts) {
    const data = nodes[id]!.data!;
    for (let index = 0; index < regularSectorCounts.get(id)!; index++) {
      ctx.budget.tick();
      const offset = sectorOffset(start + index);
      const dataStart = index * sectorSize;
      bytes.set(data.subarray(dataStart, Math.min(data.length, dataStart + sectorSize)), offset);
    }
  }
  for (let index = 0; index < miniStreamParts.length; index++) {
    ctx.budget.tick();
    const part = miniStreamParts[index]!;
    const offset = sectorOffset(rootMiniStart) + index * miniSectorSize;
    bytes.set(part, offset);
  }
  if (miniFatSectors > 0) {
    const miniFatByteOffset = sectorOffset(miniFatStart);
    bytes.fill(0xff, miniFatByteOffset, miniFatByteOffset + miniFatSectors * sectorSize);
    for (let index = 0; index < miniFat.length; index++) {
      ctx.budget.tick();
      view.setUint32(miniFatByteOffset + index * 4, miniFat[index]!, true);
    }
  }
  for (let index = 0; index < nodes.length; index++) {
    ctx.budget.tick();
    const node = nodes[index]!;
    const offset = sectorOffset(directoryStart) + index * 128;
    for (let char = 0; char < node.name.length; char++) {
      ctx.budget.tick();
      view.setUint16(offset + char * 2, node.name.charCodeAt(char), true);
    }
    view.setUint16(offset + node.name.length * 2, 0, true);
    view.setUint16(offset + 64, (node.name.length + 1) * 2, true);
    view.setUint8(offset + 66, node.type === 'root' ? 5 : node.type === 'storage' ? 1 : 2);
    view.setUint8(offset + 67, 1);
    view.setUint32(offset + 68, node.left, true);
    view.setUint32(offset + 72, node.right, true);
    view.setUint32(offset + 76, node.child, true);
    view.setUint32(offset + 116, node.startSector, true);
    view.setUint32(offset + 120, node.size, true);
  }
  const fatEntries = new Uint32Array(fatSectors * (sectorSize / 4));
  fatEntries.fill(freeSector);
  for (const [sectorId, next] of fatLinks) {
    ctx.budget.tick();
    fatEntries[sectorId] = next;
  }
  for (let index = 0; index < fatStarts.length; index++) {
    for (let entry = 0; entry < sectorSize / 4; entry++) {
      ctx.budget.tick();
      view.setUint32(
        sectorOffset(fatStarts[index]!) + entry * 4,
        fatEntries[index * (sectorSize / 4) + entry]!,
        true,
      );
    }
  }
  return bytes;
}

/** Decompress an MS-OXRTFCP stream after checking declared size and ratio limits. */
export function decompressCompressedRtf(bytes: Uint8Array, budget: Budget): Uint8Array | undefined {
  budget.tick();
  if (bytes.length < 16) throw new CorruptFileError('The MSG compressed RTF stream is malformed.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressedSize = view.getUint32(0, true);
  const rawSize = view.getUint32(4, true);
  const compressionType = view.getUint32(8, true);
  const crc = view.getUint32(12, true);
  if (compressedSize < 12 || compressedSize > bytes.length - 4) {
    throw new CorruptFileError('The MSG compressed RTF stream is malformed.');
  }
  if (!budget.checkUncompressed(rawSize)) return undefined;
  if (compressionType === MELA) {
    if (rawSize > compressedSize - 12 || 16 + rawSize > bytes.length)
      throw new CorruptFileError('The MSG RTF stream is malformed.');
    const result = new Uint8Array(rawSize);
    for (let index = 0; index < rawSize; index++) {
      budget.tick();
      result[index] = bytes[16 + index]!;
      budget.addUncompressed(1);
    }
    return result;
  }
  if (compressionType !== LZFU)
    throw new CorruptFileError('The MSG compressed RTF stream uses an unsupported encoding.');
  const compressedEnd = 4 + compressedSize;
  const compressed = bytes.subarray(16, compressedEnd);
  if (!budget.checkRatio(compressed.length, rawSize)) return undefined;
  if (crc32(compressed, budget) !== crc)
    throw new CorruptFileError('The MSG compressed RTF checksum is invalid.');
  const result = new Uint8Array(rawSize);
  const dictionary = new Uint8Array(DICTIONARY_SIZE);
  for (let index = 0; index < INITIAL_DICTIONARY.length; index++)
    dictionary[index] = INITIAL_DICTIONARY.charCodeAt(index);
  let writePosition = DICTIONARY_START;
  let outputLength = 0;
  let input = 16;
  let complete = false;
  while (input < compressedEnd && outputLength < rawSize && !complete) {
    budget.tick();
    const control = bytes[input++]!;
    for (let bit = 0; bit < 8 && input < compressedEnd && outputLength < rawSize; bit++) {
      budget.tick();
      if ((control & (1 << bit)) === 0) {
        const byte = bytes[input++]!;
        result[outputLength++] = byte;
        dictionary[writePosition] = byte;
        writePosition = (writePosition + 1) & 0xfff;
        budget.addUncompressed(1);
        continue;
      }
      if (input + 1 >= compressedEnd)
        throw new CorruptFileError('The MSG compressed RTF stream is malformed.');
      const reference = (bytes[input]! << 8) | bytes[input + 1]!;
      input += 2;
      let readPosition = reference >>> 4;
      const length = (reference & 0xf) + 2;
      if (readPosition === writePosition) {
        complete = true;
        break;
      }
      for (let index = 0; index < length && outputLength < rawSize; index++) {
        budget.tick();
        const byte = dictionary[readPosition]!;
        readPosition = (readPosition + 1) & 0xfff;
        result[outputLength++] = byte;
        dictionary[writePosition] = byte;
        writePosition = (writePosition + 1) & 0xfff;
        budget.addUncompressed(1);
      }
    }
  }
  if (outputLength !== rawSize) throw new CorruptFileError('The MSG compressed RTF stream ended early.');
  return result;
}

function crc32(bytes: Uint8Array, budget: Budget): number {
  let crc = 0;
  for (const byte of bytes) {
    budget.tick();
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
}

function getTransportValue(
  archive: IndexedArchive,
  propertyId: string,
  codePage: number,
  ctx: ReadContext,
): string | undefined {
  return decodePropertyString(ctx, archive, `__substg1.0_${propertyId}`, codePage, ctx.budget);
}

function recipientValues(
  ctx: ReadContext,
  archive: IndexedArchive,
  codePage: number,
): { to?: string; cc?: string } {
  const to: string[] = [];
  const cc: string[] = [];
  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (entry.type !== 'storage' || !/^__recip_version1\.0_#/.test(entry.path)) continue;
    const recipientType = propertyLong(ctx, archive, 0x0c15, entry.path);
    if (recipientType !== 1 && recipientType !== 2) continue;
    const address =
      decodePropertyString(ctx, archive, `${entry.path}/__substg1.0_3003`, codePage, ctx.budget) ??
      decodePropertyString(ctx, archive, `${entry.path}/__substg1.0_3001`, codePage, ctx.budget);
    if (!address) continue;
    (recipientType === 1 ? to : cc).push(address);
  }
  return { ...(to.length ? { to: to.join('; ') } : {}), ...(cc.length ? { cc: cc.join('; ') } : {}) };
}

export const reader: Reader = {
  id: 'msg',
  mimeTypes: [MIME],
  detect(bytes) {
    return bytes.length >= 8 &&
      bytes[0] === 0xd0 &&
      bytes[1] === 0xcf &&
      bytes[2] === 0x11 &&
      bytes[3] === 0xe0
      ? 0.9
      : 0;
  },
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const archive = indexArchive(ctx, ctx.cfb ?? openCfb(ctx.bytes, ctx.budget));
    const codePage = propertyLong(ctx, archive, 0x3fde) ?? 1252;
    const get = (propertyId: string) => getTransportValue(archive, propertyId, codePage, ctx);
    const subject = decodeHeader(ctx, get('0037'));
    const from = decodeHeader(ctx, get('0C1F') ?? get('0C1A'));
    const recipients = recipientValues(ctx, archive, codePage);
    const to = decodeHeader(ctx, get('0E04') || recipients.to);
    const cc = decodeHeader(ctx, get('0E03') || recipients.cc);
    const date = decodeFileTime(propertyValue(ctx, archive, 0x0039, 0x0040));
    if (subject) ctx.out.setMetadata({ title: subject });
    if (from && ctx.options.metadata) ctx.out.setMetadata({ authors: [from] });

    const rows: Cell[][] = [[{ text: 'Field' }, { text: 'Value' }]];
    if (ctx.options.metadata && from) rows.push([{ text: 'From' }, { text: from }]);
    if (ctx.options.metadata && to) rows.push([{ text: 'To' }, { text: to }]);
    if (ctx.options.metadata && cc) rows.push([{ text: 'Cc' }, { text: cc }]);
    if (date) {
      ctx.out.setMetadata({ created: date });
      rows.push([{ text: 'Date' }, { text: date }]);
    }
    if (subject) rows.push([{ text: 'Subject' }, { text: subject }]);
    if (rows.length > 1) ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});

    await readAttachments(ctx, archive, codePage);
    const body = get('1000');
    if (body) {
      emitPlain(ctx, body);
      return;
    }
    const html = stream(archive, '__substg1.0_10130102');
    if (html) {
      emitHtml(ctx, decodeHtml(ctx, html, codePage));
      return;
    }
    const compressed = stream(archive, '__substg1.0_10090102');
    if (!compressed) return;
    const rtf = decompressCompressedRtf(compressed, ctx.budget);
    if (!rtf) return;
    const htmlBody = deencapsulateRtfHtml(rtf, ctx.budget);
    if (htmlBody !== undefined) {
      emitHtml(ctx, htmlBody);
      return;
    }
    const nested: ReadContext = { ...ctx, bytes: rtf };
    await rtfReader.read(nested);
  },
};

export default reader;

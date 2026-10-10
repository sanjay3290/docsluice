/**
 * Builders for BIFF8 workbooks in tests: records, strings, and a minimal compound file (CFB v3) that
 * holds one `Workbook` stream. The stream is padded past the 4,096-byte mini-stream cutoff so it lives
 * in regular sectors.
 */
const SECTOR = 512;
const END_OF_CHAIN = 0xffff_fffe;
const FREE = 0xffff_ffff;
const FAT_SECTOR = 0xffff_fffd;
const NO_STREAM = 0xffff_ffff;

export function record(type: number, ...parts: Array<Uint8Array | number[]>): Uint8Array {
  const data = concat(parts.map((part) => (part instanceof Uint8Array ? part : Uint8Array.from(part))));
  const out = new Uint8Array(4 + data.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, type, true);
  view.setUint16(2, data.length, true);
  out.set(data, 4);
  return out;
}

/** A record header that claims `length` bytes, whatever follows. */
export function rawHeader(type: number, length: number): Uint8Array {
  return Uint8Array.of(type & 0xff, type >> 8, length & 0xff, length >> 8);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

export function f64(value: number): number[] {
  return Array.from(new Uint8Array(Float64Array.of(value).buffer));
}

/** Characters as compressed (Latin-1) or UTF-16LE bytes, without length or flags. */
export function chars(text: string, wide: boolean): number[] {
  const out: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (wide) out.push(code & 0xff, code >> 8);
    else out.push(code);
  }
  return out;
}

/** `XLUnicodeString` (16-bit length) or `ShortXLUnicodeString` (8-bit length). */
export function xlString(text: string, short = false): number[] {
  const wide = [...text].some((char) => char.charCodeAt(0) > 0xff);
  return [...(short ? [text.length] : u16(text.length)), wide ? 1 : 0, ...chars(text, wide)];
}

export const BOF_GLOBALS = record(0x0809, [
  ...u16(0x0600),
  ...u16(0x0005),
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
]);
export const BOF_SHEET = record(0x0809, [...u16(0x0600), ...u16(0x0010), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
export const EOF = record(0x000a);

/** One XF record with the given number format id. */
export function xf(formatId: number): Uint8Array {
  return record(0x00e0, [...u16(0), ...u16(formatId), ...new Array<number>(16).fill(0)]);
}

/**
 * A workbook stream: globals (with `globals` records and one BOUNDSHEET8 per sheet), then each sheet's
 * records between BOF and EOF. Sheet offsets are filled in.
 */
export function workbookStream(
  globals: Uint8Array[],
  sheets: Array<{ name: string; records: Uint8Array[]; hidden?: number; kind?: number }>,
): Uint8Array {
  const boundSheet = (offset: number, sheet: { name: string; hidden?: number; kind?: number }) =>
    record(0x0085, [...u32(offset), sheet.hidden ?? 0, sheet.kind ?? 0, ...xlString(sheet.name, true)]);
  const head = concat([BOF_GLOBALS, ...globals]);
  let size = head.length + EOF.length;
  for (const sheet of sheets) size += boundSheet(0, sheet).length;
  const bodies: Uint8Array[] = [];
  const bounds: Uint8Array[] = [];
  for (const sheet of sheets) {
    bounds.push(boundSheet(size, sheet));
    const body = concat([BOF_SHEET, ...sheet.records, EOF]);
    bodies.push(body);
    size += body.length;
  }
  return concat([head, ...bounds, EOF, ...bodies]);
}

function utf16Name(name: string): Uint8Array {
  const out = new Uint8Array(64);
  for (let index = 0; index < name.length; index++) out[index * 2] = name.charCodeAt(index);
  return out;
}

/** A compound file with one stream (default `Workbook`). */
export function compoundFile(stream: Uint8Array, name = 'Workbook'): Uint8Array {
  const padded = new Uint8Array(Math.max(4096, Math.ceil(stream.length / SECTOR) * SECTOR));
  padded.set(stream);
  const streamSectors = padded.length / SECTOR;
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < fatSectors + 1 + streamSectors) fatSectors++;
  const total = fatSectors + 1 + streamSectors;
  const out = new Uint8Array(SECTOR * (total + 1));
  const view = new DataView(out.buffer);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(24, 0x003e, true);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint16(32, 6, true);
  view.setUint32(44, fatSectors, true);
  view.setUint32(48, fatSectors, true);
  view.setUint32(56, 4096, true);
  view.setUint32(60, END_OF_CHAIN, true);
  view.setUint32(68, END_OF_CHAIN, true);
  for (let index = 0; index < 109; index++)
    view.setUint32(76 + index * 4, index < fatSectors ? index : FREE, true);
  const sectorOffset = (id: number) => SECTOR * (id + 1);
  // FAT: FAT sectors, then the directory, then the stream chain.
  const fat = (index: number, value: number) =>
    view.setUint32(sectorOffset(Math.floor(index / 128)) + (index % 128) * 4, value, true);
  for (let index = 0; index < fatSectors * 128; index++) fat(index, FREE);
  for (let index = 0; index < fatSectors; index++) fat(index, FAT_SECTOR);
  fat(fatSectors, END_OF_CHAIN);
  const first = fatSectors + 1;
  for (let index = 0; index < streamSectors; index++)
    fat(first + index, index === streamSectors - 1 ? END_OF_CHAIN : first + index + 1);
  // Directory: root, then the stream, then two unused entries.
  const directory = sectorOffset(fatSectors);
  const entry = (
    index: number,
    entryName: string,
    type: number,
    child: number,
    start: number,
    size: number,
  ) => {
    const base = directory + index * 128;
    out.set(utf16Name(entryName), base);
    view.setUint16(base + 64, (entryName.length + 1) * 2, true);
    out[base + 66] = type;
    out[base + 67] = 1;
    view.setUint32(base + 68, NO_STREAM, true);
    view.setUint32(base + 72, NO_STREAM, true);
    view.setUint32(base + 76, child, true);
    view.setUint32(base + 116, start, true);
    view.setUint32(base + 120, size, true);
  };
  entry(0, 'Root Entry', 5, 1, END_OF_CHAIN, 0);
  entry(1, name, 2, NO_STREAM, first, padded.length);
  for (const index of [2, 3]) {
    const base = directory + index * 128;
    view.setUint32(base + 68, NO_STREAM, true);
    view.setUint32(base + 72, NO_STREAM, true);
    view.setUint32(base + 76, NO_STREAM, true);
  }
  out.set(padded, sectorOffset(first));
  return out;
}

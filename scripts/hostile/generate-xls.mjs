import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile BIFF8 workbooks in a minimal compound file: SST count lies, CONTINUE abuse, record length
// lies, sheet offsets that repeat or point anywhere, FILEPASS encryption and a BIFF5 workbook.
const directory = new URL('../../hostile/xls/', import.meta.url);
await mkdir(directory, { recursive: true });

const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const f64 = (value) => [...new Uint8Array(Float64Array.of(value).buffer)];
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const record = (type, data = []) => Uint8Array.from([...u16(type), ...u16(data.length), ...data]);
const header = (type, length) => Uint8Array.from([...u16(type), ...u16(length)]);
const bof = (kind) => record(0x0809, [...u16(0x0600), ...u16(kind), ...new Array(12).fill(0)]);
const EOF = record(0x000a);
const xf = record(0x00e0, [...u16(0), ...u16(0), ...new Array(16).fill(0)]);
// Sheet names are fixed-width so every BOUNDSHEET8 record has the same length.
const name = (text) => [text.length, 0, ...[...text].map((char) => char.charCodeAt(0))];

/** Globals with `sheetOffsets.length` BOUNDSHEET8 records, then the given sheet bodies. */
function workbook(globals, sheetOffsets, bodies) {
  const head = concat([bof(0x0005), xf, ...globals]);
  const bounds = sheetOffsets.map((offset, index) => record(0x0085, [...u32(offset), 0, 0, ...name(`S${String(index).padStart(5, '0')}`)]));
  return concat([head, ...bounds, EOF, ...bodies]);
}
const globalsSize = (globals, sheets) =>
  concat([bof(0x0005), xf, ...globals]).length + sheets * record(0x0085, [...u32(0), 0, 0, ...name('S00000')]).length + EOF.length;

/** A compound file (CFB v3) with one stream in regular sectors. */
function compoundFile(stream, streamName = 'Workbook') {
  const size = 512;
  const padded = new Uint8Array(Math.max(4096, Math.ceil(stream.length / size) * size));
  padded.set(stream);
  const streamSectors = padded.length / size;
  let fatSectors = 1;
  while (fatSectors * 128 < fatSectors + 1 + streamSectors) fatSectors++;
  if (fatSectors > 109) throw new Error('stream too large for the header DIFAT');
  const total = fatSectors + 1 + streamSectors;
  const out = new Uint8Array(size * (total + 1));
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
  view.setUint32(60, 0xfffffffe, true);
  view.setUint32(68, 0xfffffffe, true);
  for (let index = 0; index < 109; index++) view.setUint32(76 + index * 4, index < fatSectors ? index : 0xffffffff, true);
  const at = (id) => size * (id + 1);
  const fat = (index, value) => view.setUint32(at(Math.floor(index / 128)) + (index % 128) * 4, value, true);
  for (let index = 0; index < fatSectors * 128; index++) fat(index, 0xffffffff);
  for (let index = 0; index < fatSectors; index++) fat(index, 0xfffffffd);
  fat(fatSectors, 0xfffffffe);
  const first = fatSectors + 1;
  for (let index = 0; index < streamSectors; index++)
    fat(first + index, index === streamSectors - 1 ? 0xfffffffe : first + index + 1);
  const directory = at(fatSectors);
  const entry = (index, entryName, type, child, start, length) => {
    const base = directory + index * 128;
    for (let char = 0; char < entryName.length; char++) out[base + char * 2] = entryName.charCodeAt(char);
    view.setUint16(base + 64, (entryName.length + 1) * 2, true);
    out[base + 66] = type;
    out[base + 67] = 1;
    view.setUint32(base + 68, 0xffffffff, true);
    view.setUint32(base + 72, 0xffffffff, true);
    view.setUint32(base + 76, child, true);
    view.setUint32(base + 116, start, true);
    view.setUint32(base + 120, length, true);
  };
  entry(0, 'Root Entry', 5, 1, 0xfffffffe, 0);
  entry(1, streamName, 2, 0xffffffff, first, padded.length);
  for (const index of [2, 3]) {
    const base = directory + index * 128;
    for (const field of [68, 72, 76]) view.setUint32(base + field, 0xffffffff, true);
  }
  out.set(padded, at(first));
  return out;
}

const sheet = (records) => concat([bof(0x0010), ...records, EOF]);
const labelSst = (row, column, index) => record(0x00fd, [...u16(row), ...u16(column), ...u16(0), ...u32(index)]);

// The SST claims 4 billion strings and holds two; cells point far past them.
{
  const sst = record(0x00fc, [...u32(0xffffffff), ...u32(0xffffffff), ...u16(1), 0, 0x41, ...u16(1), 0, 0x42]);
  const body = sheet([labelSst(0, 0, 0), labelSst(0, 1, 1), labelSst(0, 2, 0xfffffff0)]);
  await writeFile(new URL('sst-count-lie.xls', directory), compoundFile(workbook([sst], [globalsSize([sst], 1)], [body])));
}

// One 100,000-character string split into 100,000 CONTINUE records of one character each.
{
  const length = 100_000;
  const parts = [record(0x00fc, [...u32(1), ...u32(1), ...u16(length), 0])];
  for (let index = 0; index < length; index++) parts.push(record(0x003c, [index % 2, 0x61, ...(index % 2 ? [0] : [])]));
  const sst = concat(parts);
  const body = sheet([labelSst(0, 0, 0)]);
  await writeFile(new URL('continue-abuse.xls', directory), compoundFile(workbook([sst], [globalsSize([sst], 1)], [body])));
}

// Records that claim more than the BIFF8 maximum, and past the end of the stream.
{
  const number = record(0x0203, [...u16(0), ...u16(0), ...u16(0), ...f64(1)]);
  const body = concat([bof(0x0010), number, header(0x0203, 0xffff), new Uint8Array(32)]);
  const second = concat([bof(0x0010), number, header(0x0203, 8000)]);
  const start = globalsSize([], 2);
  await writeFile(
    new URL('record-length-lies.xls', directory),
    compoundFile(workbook([], [start, start + body.length], [body, second])),
  );
}

// 5,000 sheets that all point at one sheet, plus offsets past the end and into the middle of records.
{
  const sheets = 5_000;
  const start = globalsSize([], sheets + 2);
  const body = sheet(Array.from({ length: 200 }, (_, index) => record(0x0203, [...u16(index), ...u16(0), ...u16(0), ...f64(index)])));
  const offsets = [...new Array(sheets).fill(start), 0x7fffffff, start + 3];
  await writeFile(new URL('sheet-offset-abuse.xls', directory), compoundFile(workbook([], offsets, [body])));
}

// FILEPASS: the workbook is encrypted; it is reported, never decrypted.
await writeFile(
  new URL('filepass.xls', directory),
  compoundFile(workbook([record(0x002f, [...u16(1), ...u16(1), ...u16(1), ...new Array(48).fill(0)])], [], [])),
);

// A BIFF5 workbook (stream "Book"): unsupported, with a warning.
await writeFile(new URL('biff5.xls', directory), compoundFile(concat([record(0x0809, [...u16(0x0500), ...u16(0x0005)]), EOF]), 'Book'));

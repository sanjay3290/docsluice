import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextEncoder } from 'node:util';
import { zipSync } from 'fflate';

// Hostile XLSB packages: record sizes and string lengths that lie, a flood of short cell records,
// cells past the last row and column, shared-string indexes past the table and a merge flood.
const directory = new URL('../../hostile/xlsb/', import.meta.url);
await mkdir(directory, { recursive: true });

const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const f64 = (value) => [...new Uint8Array(Float64Array.of(value).buffer)];
const wide = (value) => [...u32(value.length), ...[...value].flatMap((char) => u16(char.charCodeAt(0)))];
function record(type, data = []) {
  const out = type < 128 ? [type] : [(type & 0x7f) | 0x80, type >> 7];
  let size = data.length;
  do {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    out.push(byte);
  } while (size > 0);
  return [...out, ...data];
}
const part = (...records) => Uint8Array.from(records.flat());
// Floods are passed as one array: spreading 100,000 records into call arguments overflows the stack.
const partOf = (records) => Uint8Array.from(records.flat());
const rowHeader = (row) => record(0, [...u32(row), ...u32(0), ...u16(256), 0, 0, 0, ...u32(0)]);
const cell = (type, column, ...value) => record(type, [...u32(column), ...u32(0), ...value]);

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function xlsb(sheet, strings = part(record(159), record(19, [0, ...wide('one')]), record(160))) {
  const files = {
    '[Content_Types].xml':
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.bin"/></Relationships>`,
    'xl/_rels/workbook.bin.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.bin"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.bin"/></Relationships>`,
    'xl/workbook.bin': part(record(131), record(156, [...u32(0), ...u32(1), ...wide('rId1'), ...wide('Sheet1')]), record(132)),
    'xl/sharedStrings.bin': strings,
    'xl/worksheets/sheet1.bin': sheet,
  };
  const entries = Object.create(null);
  for (const [name, data] of Object.entries(files)) {
    entries[name] = [typeof data === 'string' ? new TextEncoder().encode(data) : data, { mtime: new Date('1980-01-01T00:00:00Z'), level: 9 }];
  }
  return zipSync(entries);
}

const files = new Map([
  // A cell record that claims 2 GB, then nothing.
  ['record-size-lie.xlsb', xlsb(part(record(145), rowHeader(0), cell(5, 0, ...f64(1)), [5, 0xff, 0xff, 0xff, 0x07, 1, 2, 3]))],
  // A string cell and a shared string whose length claims four billion characters.
  [
    'string-length-lie.xlsb',
    xlsb(
      part(record(145), rowHeader(0), cell(6, 0, ...u32(0xffff_fffe), 0x41, 0)),
      part(record(159), record(19, [0, ...u32(0x7fff_ffff), 0x41, 0]), record(160)),
    ),
  ],
  // 100,000 short blank and number records in one row: 16,384 columns, then everything past the last column.
  [
    'short-cell-flood.xlsb',
    xlsb(partOf([record(145), rowHeader(0), ...Array.from({ length: 100_000 }, (_, index) => (index % 2 ? record(12, u32(0)) : record(13, [...u32(0), ...u32((1 << 2) | 2)])))])),
  ],
  // Cells past row 1,048,576 and column 16,384, and a row number of 0xFFFFFFFF.
  [
    'out-of-range-cells.xlsb',
    xlsb(part(record(145), rowHeader(2_000_000), cell(5, 0, ...f64(1)), rowHeader(0), cell(5, 0xffff_ffff, ...f64(2)), cell(5, 20_000, ...f64(3)), rowHeader(0xffff_ffff), cell(5, 1, ...f64(4)), rowHeader(1), cell(5, 1, ...f64(5)))),
  ],
  // Shared-string indexes far past the table.
  ['sst-index-lie.xlsb', xlsb(part(record(145), rowHeader(0), cell(7, 0, ...u32(0xffff_ffff)), cell(7, 1, ...u32(5_000_000))))],
  // 50,000 merges over the whole sheet.
  [
    'merge-flood.xlsb',
    xlsb(partOf([record(145), rowHeader(0), cell(5, 0, ...f64(1)), record(146), ...Array.from({ length: 50_000 }, () => record(176, [...u32(0), ...u32(1_048_575), ...u32(0), ...u32(16_383)]))])),
  ],
]);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);

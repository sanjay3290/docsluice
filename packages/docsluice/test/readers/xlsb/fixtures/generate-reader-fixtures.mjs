/* Self-authored minimal XLSB edge fixtures. CC0-1.0; see the adjacent license file. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const output = dirname(fileURLToPath(import.meta.url));

function u16(value) {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function u32(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function wide(value) {
  const units = [];
  for (let offset = 0; offset < value.length; offset++) units.push(value.charCodeAt(offset));
  return [...u32(units.length), ...units.flatMap(u16)];
}

function record(type, payload = []) {
  const typeBytes = type < 128 ? [type] : [0x80 | (type & 0x7f), (type >>> 7) & 0x7f];
  let size = payload.length;
  const sizeBytes = [];
  while (size > 0x7f) {
    sizeBytes.push((size & 0x7f) | 0x80);
    size >>>= 7;
  }
  sizeBytes.push(size);
  return Uint8Array.from([...typeBytes, ...sizeBytes, ...payload]);
}

function records(items) {
  const size = items.reduce((total, item) => total + item.length, 0);
  const outputBytes = new Uint8Array(size);
  let offset = 0;
  for (const item of items) {
    outputBytes.set(item, offset);
    offset += item.length;
  }
  return outputBytes;
}

function cellInfo(column, style = 0) {
  return [...u32(column), ...u32(style)];
}

function rowHeader(row, columns, hidden = false) {
  return record(0, [
    ...u32(row),
    ...u32(0),
    ...u16(300),
    0,
    hidden ? 0x10 : 0,
    0,
    ...u32(columns.length),
    ...columns.flatMap(([first, last]) => [...u32(first), ...u32(last)]),
  ]);
}

function xf(parent, numFmt, flags = 1) {
  return [...u16(parent), ...u16(numFmt), ...u16(0), ...u16(0), ...u16(0), 0, 0, ...u16(0), ...u16(flags)];
}

function sharedStrings() {
  const text = 'Alpha';
  const item = [1, ...wide(text), ...u32(1), ...u16(0), ...u16(0)];
  return records([record(159, [...u32(1), ...u32(1)]), record(19, item), record(160)]);
}

function styles(dateCode = 'yyyy-mm-dd') {
  const fmt = dateCode === 'yyyy-mm-dd' ? dateCode : '#,##0.00';
  const code = 164;
  return records([
    record(278),
    record(87, u32(1)),
    record(44, [...u16(code), ...wide(fmt)]),
    record(616),
    record(626, u32(1)),
    record(47, xf(0xffff, 0, 0)),
    record(627),
    record(617, u32(2)),
    record(47, xf(0, 0)),
    record(47, xf(0, code)),
    record(618),
    record(586),
  ]);
}

function sheetMain(badSharedIndex = false) {
  const mainRow = [
    record(60, [...u32(3), ...u32(3), ...u32(0), ...u32(0), ...u16(1)]),
    rowHeader(0, [[0, 2]]),
    record(7, [...cellInfo(0), ...u32(badSharedIndex ? 99 : 0)]),
    record(5, [...cellInfo(1, 1), ...f64(1234.5)]),
    record(9, [...cellInfo(2), ...f64(42.5), ...u16(0), ...u32(0), ...u32(0)]),
    rowHeader(1, [[1, 3]], true),
    record(4, [...cellInfo(1), 1]),
    rowHeader(2, [[0, 2]]),
    record(2, [...cellInfo(0), ...u32((123 << 2) | 3)]),
    record(6, [...cellInfo(1), ...wide('inline')]),
    record(3, [...cellInfo(2), 0x2a]),
    rowHeader(3, [[3, 3]]),
    record(6, [...cellInfo(3), ...wide('secret')]),
    rowHeader(4, [[4, 4]]),
    record(6, [...cellInfo(4), ...wide('merged')]),
    rowHeader(5, [[0, 1]]),
    record(6, [...cellInfo(0), ...wide('top')]),
    record(5, [...cellInfo(1), ...f64(2)]),
    rowHeader(6, [[0, 1]]),
    record(6, [...cellInfo(0), ...wide('bottom')]),
    record(5, [...cellInfo(1), ...f64(3)]),
    rowHeader(89999, [[25, 25]]),
    record(6, [...cellInfo(25), ...wide('far')]),
  ];
  return records([
    record(129),
    ...mainRow.slice(0, 1),
    record(145),
    ...mainRow.slice(1),
    record(146),
    record(177, u32(1)),
    record(176, [...u32(4), ...u32(4), ...u32(4), ...u32(5)]),
    record(178),
    record(130),
  ]);
}

function f64(value) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return [...bytes];
}

function sheet1904() {
  const header = rowHeader(0, [[0, 1]]);
  const date = record(5, [...cellInfo(0, 1), ...f64(0)]);
  const formula = record(8, [...cellInfo(1), ...wide('cached'), ...u16(0), ...u32(0), ...u32(0)]);
  return records([record(129), record(145), header, date, formula, record(146), record(130)]);
}

function sheetBlanks() {
  return records([
    record(129),
    record(145),
    rowHeader(0, [[0, 2]]),
    record(6, [...cellInfo(0), ...wide('left')]),
    record(1, cellInfo(1)),
    record(6, [...cellInfo(2), ...wide('right')]),
    rowHeader(2, [[3, 3]]),
    record(1, cellInfo(3)),
    record(146),
    record(130),
  ]);
}

function sheetQuota(text) {
  return records([
    record(129),
    record(145),
    rowHeader(0, [[0, 0]]),
    record(6, [...cellInfo(0), ...wide(text)]),
    record(146),
    record(130),
  ]);
}

function sheetWarningPaths() {
  return records([
    record(60, [...u32(3), ...u32(2), ...u32(0), ...u32(0), ...u16(1)]),
    record(176, [...u32(1), ...u32(0), ...u32(0), ...u32(0)]),
    record(129),
    record(145),
    rowHeader(0, [[0, 0]]),
    record(6, [...cellInfo(0), ...wide('kept')]),
    record(6, [...cellInfo(0), ...wide('duplicate')]),
    record(2, [...cellInfo(1), ...u32(0x7ff0_0000)]),
    record(0, u32(1)),
    record(146),
    record(130),
  ]);
}

function sheetInvalidRk() {
  return records([
    record(129),
    record(145),
    rowHeader(0, [[0, 0]]),
    record(2, [...cellInfo(0), ...u32(0x7ff0_0000)]),
    record(146),
    record(130),
  ]);
}

function malformedStyles() {
  return records([record(87, u32(1)), record(44, u16(164))]);
}

function bundleSheet(state, tabId, relId, name) {
  return record(156, [...u32(state), ...u32(tabId), ...wide(relId), ...wide(name)]);
}

function workbook(date1904 = false, malformed = false, quota = false, linkWarnings = false) {
  if (malformed) return Uint8Array.from([0x80, 0x00, 0x00]);
  return records([
    record(131),
    record(153, [...u32(date1904 ? 1 : 0), ...u32(0), ...wide('Book')]),
    record(143),
    bundleSheet(0, 1, 'rId10', quota ? 'A' : 'Main'),
    bundleSheet(1, 2, 'rId2', quota ? 'B' : 'Hidden'),
    bundleSheet(2, 3, 'rId1', quota ? 'C' : 'Very'),
    ...(linkWarnings
      ? [
          bundleSheet(0, 4, 'rIdMissing', 'Missing'),
          bundleSheet(0, 5, 'rIdChart', 'Chart'),
          bundleSheet(0, 6, 'rId10', ''),
          bundleSheet(0, 7, 'rId10', 'main'),
        ]
      : []),
    record(144),
    record(132),
  ]);
}

function workbookRels(linkWarnings = false) {
  return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    <Relationship Id="rId10" Type="http://schemas.microsoft.com/office/2006/relationships/worksheet" Target="worksheets/sheet10.bin"/>
    <Relationship Id="rId2" Type="http://schemas.microsoft.com/office/2006/relationships/worksheet" Target="worksheets/sheet2.bin"/>
    <Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2006/relationships/worksheet" Target="worksheets/sheet1.bin"/>
    <Relationship Id="strings" Type="http://schemas.microsoft.com/office/2006/relationships/sharedStrings" Target="sharedStrings.bin"/>
    <Relationship Id="styles" Type="http://schemas.microsoft.com/office/2006/relationships/styles" Target="styles.bin"/>
    ${linkWarnings ? '<Relationship Id="rIdChart" Type="http://schemas.microsoft.com/office/2006/relationships/chartsheet" Target="chartsheets/chart1.bin"/>' : ''}
  </Relationships>`;
}

function packageBytes({
  date1904 = false,
  malformed = false,
  malformedWorksheet = false,
  main = false,
  badShared = false,
  blanks = false,
  quota = false,
  warningPaths = false,
  malformedStyleData = false,
  linkWarnings = false,
  invalidRk = false,
} = {}) {
  const files = {
    '[Content_Types].xml': strToU8(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>`,
    ),
    '_rels/.rels': strToU8(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.microsoft.com/office/2006/relationships/officeDocument" Target="xl/workbook.bin"/></Relationships>`,
    ),
    'xl/workbook.bin': workbook(date1904, malformed, quota, linkWarnings),
    'xl/_rels/workbook.bin.rels': strToU8(workbookRels(linkWarnings)),
    'xl/styles.bin': malformedStyleData ? malformedStyles() : styles(date1904 ? 'yyyy-mm-dd' : '#,##0.00'),
    'xl/sharedStrings.bin': sharedStrings(),
    'xl/worksheets/sheet10.bin': malformedWorksheet
      ? records([record(129), record(145), record(0, u32(0))])
      : invalidRk
        ? sheetInvalidRk()
        : warningPaths
          ? sheetWarningPaths()
          : blanks
            ? sheetBlanks()
            : quota
              ? sheetQuota('x'.repeat(128))
              : main
                ? sheetMain(badShared)
                : sheet1904(),
    'xl/worksheets/sheet2.bin': quota
      ? sheetQuota('ok')
      : records([record(129), record(145), record(146), record(130)]),
    'xl/worksheets/sheet1.bin': records([record(129), record(145), record(146), record(130)]),
    ...(linkWarnings ? { 'xl/chartsheets/chart1.bin': records([record(129), record(130)]) } : {}),
  };
  return zipSync(files, { level: 0, mtime: new Date('1980-01-01T00:00:00Z') });
}

const edgecaseBytes = packageBytes({ main: true });
writeFileSync(join(output, 'reader-edgecases.xlsb'), edgecaseBytes);
writeFileSync(join(output, 'reader-bad-shared-index.xlsb'), packageBytes({ main: true, badShared: true }));
writeFileSync(join(output, 'reader-1904.xlsb'), packageBytes({ date1904: true }));
writeFileSync(join(output, 'reader-malformed.xlsb'), packageBytes({ malformed: true }));
writeFileSync(join(output, 'reader-malformed-worksheet.xlsb'), packageBytes({ malformedWorksheet: true }));
writeFileSync(join(output, 'reader-blanks.xlsb'), packageBytes({ blanks: true }));
writeFileSync(join(output, 'reader-retention-order.xlsb'), packageBytes({ quota: true }));
writeFileSync(join(output, 'reader-warning-paths.xlsb'), packageBytes({ warningPaths: true }));
writeFileSync(
  join(output, 'reader-malformed-styles.xlsb'),
  packageBytes({ main: true, malformedStyleData: true }),
);
writeFileSync(join(output, 'reader-link-warnings.xlsb'), packageBytes({ main: true, linkWarnings: true }));
writeFileSync(join(output, 'reader-invalid-rk.xlsb'), packageBytes({ invalidRk: true }));

const corpus = join(output, 'corpus');
mkdirSync(corpus, { recursive: true });
writeFileSync(join(corpus, 'edgecases.xlsb'), edgecaseBytes);
writeFileSync(
  join(corpus, 'edgecases.expected.json'),
  `${JSON.stringify(
    {
      provenance: 'Self-authored expected ranges and addresses; not an Excel or LibreOffice golden.',
      sheets: [
        {
          name: 'Main',
          state: 'visible',
          ranges: ['A1:C1', 'B2', 'A3:C3', 'D4', 'E5', 'A6:B7', 'Z90000'],
          addresses: [
            ['A1', 'B1', 'C1'],
            ['B2'],
            ['A3', 'B3', 'C3'],
            ['D4'],
            ['E5'],
            ['A6', 'B6', 'A7', 'B7'],
            ['Z90000'],
          ],
        },
        { name: 'Hidden', state: 'hidden', ranges: [], addresses: [] },
        { name: 'Very', state: 'very', ranges: [], addresses: [] },
      ],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(corpus, 'edgecases.xlsb.license'),
  'CC0-1.0. A copy of the self-authored deterministic XLSB edge fixture generated by the adjacent script. No third-party workbook data.\n',
);
writeFileSync(
  join(corpus, 'edgecases.expected.json.license'),
  'CC0-1.0. Self-authored expected range and address summary for the adjacent synthetic XLSB fixture.\n',
);

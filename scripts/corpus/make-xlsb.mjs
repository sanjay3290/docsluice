// XLSB versions of XLSX corpus workbooks, written from the [MS-XLSB] specification (record layout
// 2.1.4, records 2.4, structures 2.5). LibreOffice reads XLSB but cannot write it, so this script
// converts the cells, shared strings, number formats, merges, sheet states and date system of each
// XLSX file. Formula cells keep their cached value; the formula is stored as that constant
// (PtgNum / PtgStr / PtgBool), because docsluice never reads formulas from XLSB.
import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import { unzipSync, zipSync } from 'fflate';

const corpus = new URL('../../corpus/', import.meta.url);
const SOURCES = ['workbook-values-formulas', 'workbook-hidden-sparse', 'workbook-merged-richstrings', 'workbook-1904-note'];
const R = {
  RowHdr: 0, CellRk: 2, CellError: 3, CellBool: 4, CellReal: 5, CellIsst: 7, FmlaString: 8, FmlaNum: 9, FmlaBool: 10,
  SSTItem: 19, Fmt: 44, XF: 47, BeginSheet: 129, EndSheet: 130, BeginBook: 131, EndBook: 132, BeginBundleShs: 143,
  EndBundleShs: 144, BeginSheetData: 145, EndSheetData: 146, WsDim: 148, WbProp: 153, BundleSh: 156, BeginSst: 159,
  EndSst: 160, MergeCell: 176, BeginMergeCells: 177, EndMergeCells: 178, BeginStyleSheet: 278, EndStyleSheet: 279,
  BeginFmts: 615, EndFmts: 616, BeginCellXFs: 617, EndCellXFs: 618, BeginCellStyleXFs: 626, EndCellStyleXFs: 627,
};
const ERRORS = new Map([['#NULL!', 0x00], ['#DIV/0!', 0x07], ['#VALUE!', 0x0f], ['#REF!', 0x17], ['#NAME?', 0x1d], ['#NUM!', 0x24], ['#N/A', 0x2a]]);

const text = (bytes) => new TextDecoder().decode(bytes);
const u16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const u32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const f64 = (value) => [...new Uint8Array(Float64Array.of(value).buffer)];
const wide = (value) => {
  const out = [...u32(value.length)];
  for (let index = 0; index < value.length; index++) out.push(...u16(value.charCodeAt(index)));
  return out;
};
const unescapeXml = (value) =>
  value.replace(/&(lt|gt|quot|apos|amp|#x[0-9a-f]+|#\d+);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
    return { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }[entity];
  });
const attr = (tag, name) => {
  const match = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag);
  return match ? unescapeXml(match[1]) : undefined;
};

/** [MS-XLSB] 2.1.4: type in 1–2 bytes and size in 1–4 bytes, seven bits each, low bits first. */
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
const part = (records) => Uint8Array.from(records.flat());

function column(reference) {
  let value = 0;
  let index = 0;
  for (; index < reference.length && reference.charCodeAt(index) >= 65; index++) value = value * 26 + reference.charCodeAt(index) - 64;
  return { column: value - 1, row: Number(reference.slice(index)) - 1 };
}

function cellRecord(cell, strings) {
  const head = [...u32(cell.column), ...u32(cell.style)];
  const formula = (ptg) => [...u16(0), ...u32(ptg.length), ...ptg, ...u32(0)];
  if (cell.formula) {
    if (cell.type === 'str') {
      const ptg = [0x17, ...u16(cell.value.length)];
      for (let index = 0; index < cell.value.length; index++) ptg.push(...u16(cell.value.charCodeAt(index)));
      return record(R.FmlaString, [...head, ...wide(cell.value), ...formula(ptg)]);
    }
    if (cell.type === 'b') return record(R.FmlaBool, [...head, Number(cell.value), ...formula([0x1d, Number(cell.value)])]);
    return record(R.FmlaNum, [...head, ...f64(Number(cell.value)), ...formula([0x1f, ...f64(Number(cell.value))])]);
  }
  switch (cell.type) {
    case 's':
      return record(R.CellIsst, [...head, ...u32(Number(cell.value))]);
    case 'inlineStr':
    case 'str':
      strings.push(cell.value);
      return record(R.CellIsst, [...head, ...u32(strings.length - 1)]);
    case 'b':
      return record(R.CellBool, [...head, Number(cell.value)]);
    case 'e':
      return record(R.CellError, [...head, ERRORS.get(cell.value) ?? 0x2a]);
    default: {
      const value = Number(cell.value);
      // Small integers use RkNumber (2.5.123): the value shifted left two bits with fInt set.
      if (Number.isInteger(value) && value >= -(2 ** 29) && value < 2 ** 29) return record(R.CellRk, [...head, ...u32(((value << 2) | 2) >>> 0)]);
      return record(R.CellReal, [...head, ...f64(value)]);
    }
  }
}

function sheetPart(xml, strings) {
  const rows = new Map();
  for (const match of xml.matchAll(/<c ([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
    const tag = match[1];
    const body = match[2] ?? '';
    const reference = column(attr(tag, 'r'));
    const value = /<v>(.*?)<\/v>/s.exec(body)?.[1];
    const inline = /<is>(.*?)<\/is>/s.exec(body)?.[1];
    const type = attr(tag, 't') ?? 'n';
    const formula = /<f[\s>]/.test(body);
    const content = type === 'inlineStr' ? [...(inline ?? '').matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((m) => m[1]).join('') : value;
    if (content === undefined) continue;
    const cells = rows.get(reference.row) ?? [];
    cells.push({ ...reference, style: Number(attr(tag, 's') ?? 0), type, formula, value: unescapeXml(content) });
    rows.set(reference.row, cells);
  }
  const merges = [...xml.matchAll(/<mergeCell ref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map((m) => [column(m[1]), column(m[2])]);
  const rowNumbers = [...rows.keys()].sort((a, b) => a - b);
  const all = rowNumbers.flatMap((row) => rows.get(row));
  const bounds = all.length
    ? [Math.min(...rowNumbers), Math.max(...rowNumbers), Math.min(...all.map((c) => c.column)), Math.max(...all.map((c) => c.column))]
    : [0, 0, 0, 0];
  const records = [record(R.BeginSheet), record(R.WsDim, bounds.flatMap(u32)), record(R.BeginSheetData)];
  for (const row of rowNumbers) {
    const cells = rows.get(row).sort((a, b) => a.column - b.column);
    // BrtRowHdr (2.4.770): rw, ixfe, miyRw, three flag bytes, then one BrtColSpan per 1,024-column block used.
    const blocks = [...new Set(cells.map((cell) => cell.column >> 10))];
    const spans = blocks.flatMap((block) => {
      const inBlock = cells.filter((cell) => cell.column >> 10 === block).map((cell) => cell.column);
      return [...u32(Math.min(...inBlock)), ...u32(Math.max(...inBlock))];
    });
    records.push(record(R.RowHdr, [...u32(row), ...u32(0), ...u16(256), 0, 0, 0, ...u32(blocks.length), ...spans]));
    for (const cell of cells) records.push(cellRecord(cell, strings));
  }
  records.push(record(R.EndSheetData));
  if (merges.length > 0) {
    records.push(record(R.BeginMergeCells, u32(merges.length)));
    for (const [first, last] of merges) records.push(record(R.MergeCell, [...u32(first.row), ...u32(last.row), ...u32(first.column), ...u32(last.column)]));
    records.push(record(R.EndMergeCells));
  }
  records.push(record(R.EndSheet));
  return part(records);
}

function stylesPart(xml) {
  const formats = [...xml.matchAll(/<numFmt ([^>]*)\/>/g)].map((m) => ({ id: Number(attr(m[1], 'numFmtId')), code: attr(m[1], 'formatCode') }));
  const cellXfs = /<cellXfs[^>]*>(.*?)<\/cellXfs>/s.exec(xml)?.[1] ?? '';
  const xfs = [...cellXfs.matchAll(/<xf ([^>]*?)\/?>/g)].map((m) => Number(attr(m[1], 'numFmtId') ?? 0));
  // BrtXF (2.4.876): ixfeParent, iFmt, iFont, iFill, ixBorder, trot, indent, alignment and attribute bits.
  const xf = (parent, format) => record(R.XF, [...u16(parent), ...u16(format), ...u16(0), ...u16(0), ...u16(0), 0, 0, 0x20, 0, 0, 0]);
  return part([
    record(R.BeginStyleSheet),
    record(R.BeginFmts, u32(formats.length)),
    ...formats.map((format) => record(R.Fmt, [...u16(format.id), ...wide(format.code)])),
    record(R.EndFmts),
    record(R.BeginCellStyleXFs, u32(1)),
    xf(0xffff, 0),
    record(R.EndCellStyleXFs),
    record(R.BeginCellXFs, u32(xfs.length)),
    ...xfs.map((format) => xf(0, format)),
    record(R.EndCellXFs),
    record(R.EndStyleSheet),
  ]);
}

for (const name of SOURCES) {
  const files = unzipSync(new Uint8Array(await readFile(new URL(`xlsx/${name}.xlsx`, corpus))));
  const workbookXml = text(files['xl/workbook.xml']);
  const rels = text(files['xl/_rels/workbook.xml.rels']);
  const targets = new Map([...rels.matchAll(/<Relationship ([^>]*)\/>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const strings = [...text(files['xl/sharedStrings.xml'] ?? new Uint8Array()).matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    unescapeXml([...m[1].matchAll(/<t[^>]*>(.*?)<\/t>/gs)].map((t) => t[1]).join('')),
  );
  const sheets = [...workbookXml.matchAll(/<sheet ([^>]*)\/>/g)].map((m, index) => ({
    name: attr(m[1], 'name'),
    state: { visible: 0, hidden: 1, veryHidden: 2 }[attr(m[1], 'state') ?? 'visible'],
    source: `xl/${targets.get(attr(m[1], 'r:id'))}`,
    target: `xl/worksheets/sheet${index + 1}.bin`,
    rid: `rId${index + 3}`,
  }));
  const date1904 = attr(/<workbookPr [^>]*>/.exec(workbookXml)?.[0] ?? '', 'date1904') === 'true';
  const sheetParts = sheets.map((sheet) => sheetPart(text(files[sheet.source]), strings));
  const book = part([
    record(R.BeginBook),
    // BrtWbProp (2.4.866): flags with f1904 in bit 0, dwThemeVersion, strName.
    record(R.WbProp, [...u32(date1904 ? 1 : 0), ...u32(0), ...wide('')]),
    record(R.BeginBundleShs),
    ...sheets.map((sheet, index) => record(R.BundleSh, [...u32(sheet.state), ...u32(index + 1), ...wide(sheet.rid), ...wide(sheet.name)])),
    record(R.EndBundleShs),
    record(R.EndBook),
  ]);
  const sst = part([
    record(R.BeginSst, [...u32(strings.length), ...u32(strings.length)]),
    ...strings.map((value) => record(R.SSTItem, [0, ...wide(value)])),
    record(R.EndSst),
  ]);
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const out = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/>' +
      sheets.map((sheet) => `<Override PartName="/${sheet.target}" ContentType="application/vnd.ms-excel.worksheet"/>`).join('') +
      '<Override PartName="/xl/styles.bin" ContentType="application/vnd.ms-excel.styles"/>' +
      '<Override PartName="/xl/sharedStrings.bin" ContentType="application/vnd.ms-excel.sharedStrings"/></Types>',
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.bin"/></Relationships>`,
    'xl/_rels/workbook.bin.rels':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.bin"/><Relationship Id="rId2" Type="${REL}/sharedStrings" Target="sharedStrings.bin"/>` +
      sheets.map((sheet) => `<Relationship Id="${sheet.rid}" Type="${REL}/worksheet" Target="${sheet.target.slice(3)}"/>`).join('') +
      '</Relationships>',
    'xl/workbook.bin': book,
    'xl/styles.bin': stylesPart(text(files['xl/styles.xml'])),
    'xl/sharedStrings.bin': sst,
  };
  sheets.forEach((sheet, index) => (out[sheet.target] = sheetParts[index]));
  const entries = Object.create(null);
  for (const [path, data] of Object.entries(out)) {
    entries[path] = [typeof data === 'string' ? new TextEncoder().encode(data) : data, { mtime: new Date('1980-01-01T00:00:00Z'), level: 9 }];
  }
  await writeFile(new URL(`xlsb/${name}.xlsb`, corpus), zipSync(entries));
}

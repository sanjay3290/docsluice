import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made workbook (CC0-1.0) with one row per number-format kind, written from ECMA-376 Part 1,
// 18.8.30 (numFmt) and 18.8.31 (built-in formats). Column A names the kind, B holds the code, C the value.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

// [kind, built-in id or custom code, value, cell type]
const rows = [
  ['General', 0, 1234.5678],
  ['Integer (1)', 1, 1234.5678],
  ['Decimals (2)', 2, 1234.5678],
  ['Thousands (3)', 3, 1234567.891],
  ['Thousands and decimals (4)', 4, -1234567.891],
  ['Percent (9)', 9, 0.4567],
  ['Percent decimals (10)', 10, 0.4567],
  ['Scientific (11)', 11, 123456789],
  ['Fraction (12)', 12, 3.25],
  ['Fraction two digits (13)', 13, 0.3333],
  ['Short date (14)', 14, 46143],
  ['Date d-mmm-yy (15)', 15, 46143],
  ['Date d-mmm (16)', 16, 46143],
  ['Date mmm-yy (17)', 17, 46143],
  ['Time h:mm AM/PM (18)', 18, 0.75],
  ['Time h:mm:ss AM/PM (19)', 19, 0.5104166667],
  ['Time h:mm (20)', 20, 0.75],
  ['Time h:mm:ss (21)', 21, 0.5104166667],
  ['Date and time (22)', 22, 46143.5],
  ['Accounting (37)', 37, -1234],
  ['Accounting red (38)', 38, -1234],
  ['Accounting decimals (39)', 39, 1234.5],
  ['Elapsed mm:ss (45)', 45, 0.0423611111],
  ['Elapsed [h]:mm:ss (46)', 46, 1.5],
  ['Text (49)', 49, 'kept as text', 's'],
  ['Currency', '"$"#,##0.00_);[Red]("$"#,##0.00)', -9876.5],
  ['Locale currency', '[$€-407] #,##0.00', 9876.5],
  ['Four sections, positive', '#,##0.00;(#,##0.00);"zero";"text: "@', 42],
  ['Four sections, negative', '#,##0.00;(#,##0.00);"zero";"text: "@', -42],
  ['Four sections, zero', '#,##0.00;(#,##0.00);"zero";"text: "@', 0],
  ['Four sections, text', '#,##0.00;(#,##0.00);"zero";"text: "@', 'label', 's'],
  ['Conditions, big', '[>=100]"big "0;[<0]"negative "0;0', 150],
  ['Conditions, small', '[>=100]"big "0;[<0]"negative "0;0', 7],
  ['Leading zeros', '00000', 42],
  ['Scaling', '#,##0,"K"', 1234567],
  ['Long date', 'dddd, mmmm d, yyyy', 46143],
  ['ISO date and time', 'yyyy-mm-dd hh:mm:ss', 46143.75],
  ['Elapsed hours', '[h]:mm', 2.25],
  ['Fictitious 1900 leap day', 'yyyy-mm-dd', 60],
  ['Escaped literal', '0.0\\ \\k\\g', 72.25],
  ['Hidden', ';;;', 5],
];

const custom = new Map();
const xfs = [0];
const styleOf = new Map([[0, 0]]);
for (const [, format] of rows) {
  let id = format;
  if (typeof format === 'string') {
    if (!custom.has(format)) custom.set(format, 164 + custom.size);
    id = custom.get(format);
  }
  if (!styleOf.has(id)) {
    styleOf.set(id, xfs.length);
    xfs.push(id);
  }
}

const strings = [];
const shared = (text) => {
  strings.push(text);
  return strings.length - 1;
};
const sheetRows = [
  `<row r="1"><c r="A1" t="s"><v>${shared('Kind')}</v></c><c r="B1" t="s"><v>${shared('Format')}</v></c><c r="C1" t="s"><v>${shared('Shown')}</v></c></row>`,
];
rows.forEach(([kind, format, value, type], index) => {
  const row = index + 2;
  const id = typeof format === 'string' ? custom.get(format) : format;
  const code = typeof format === 'string' ? format : `built-in ${format}`;
  const style = styleOf.get(id);
  const cell =
    type === 's'
      ? `<c r="C${row}" s="${style}" t="s"><v>${shared(value)}</v></c>`
      : `<c r="C${row}" s="${style}"><v>${value}</v></c>`;
  sheetRows.push(
    `<row r="${row}"><c r="A${row}" t="s"><v>${shared(kind)}</v></c><c r="B${row}" t="inlineStr"><is><t>${escape(code)}</t></is></c>${cell}</row>`,
  );
});

const numFmts = [...custom].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escape(code)}"/>`).join('');
const cellXfs = xfs.map((id) => `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0"/>`).join('');
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const files = {
  '[Content_Types].xml': xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/></Types>`,
  ),
  '_rels/.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  ),
  'xl/workbook.xml': xml(
    `<workbook xmlns="${S}" xmlns:r="${R}"><workbookPr date1904="false"/><sheets><sheet name="Formats" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  ),
  'xl/_rels/workbook.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  ),
  'xl/styles.xml': xml(
    `<styleSheet xmlns="${S}"><numFmts count="${custom.size}">${numFmts}</numFmts><fonts count="1"><font/></fonts><fills count="1"><fill/></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${cellXfs}</cellXfs></styleSheet>`,
  ),
  'xl/sharedStrings.xml': xml(
    `<sst xmlns="${S}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((text) => `<si><t>${escape(text)}</t></si>`).join('')}</sst>`,
  ),
  'xl/worksheets/sheet1.xml': xml(`<worksheet xmlns="${S}"><sheetData>${sheetRows.join('')}</sheetData></worksheet>`),
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/xlsx/number-formats.xlsx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/xlsx/number-formats.xlsx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-xlsx-numfmt.mjs\nRequirements: XLS-3\nNotes: one row per number-format kind: built-in ids, sections, conditions, colours, currency, scaling, dates, times, elapsed time, the 1900 leap-day bug, text sections and a hidden format.\n',
);

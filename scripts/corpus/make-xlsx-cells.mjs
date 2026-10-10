import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made workbook (CC0-1.0), written from ECMA-376 Part 1, 18.2 (workbook), 18.3 (sheets) and
// 18.4 (shared strings). Workbook order differs from part names on purpose.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;
const sheet = (rows, extra = '') =>
  xml(`<worksheet xmlns="${S}" xmlns:r="${R}"><dimension ref="A1:Z99"/><sheetData>${rows}</sheetData>${extra}</worksheet>`);

const sharedStrings = [
  '<si><t>Item</t></si>',
  '<si><t>Kind</t></si>',
  '<si><t>Value</t></si>',
  // Rich text: two runs, plus a phonetic run that is not cell text.
  '<si><r><rPr><b/></rPr><t>Bold</t></r><r><t xml:space="preserve"> and plain</t></r><rPh sb="0" eb="1"><t>ぼーるど</t></rPh></si>',
  '<si><t>Merged heading</t></si>',
  '<si><t>Archive</t></si>',
];

const data = sheet(
  [
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>',
    '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" t="inlineStr"><is><t>inline</t></is></c><c r="C2" t="inlineStr"><is><r><t>inline </t></r><r><rPr><i/></rPr><t>rich</t></r></is></c></row>',
    '<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="b"><v>0</v></c><c r="C3" t="e"><v>#N/A</v></c></row>',
    '<row r="4"><c r="A4"><v>0.30000000000000004</v></c><c r="B4"><v>1E+21</v></c><c r="C4"><v>-42</v></c></row>',
    '<row r="5"><c r="A5" t="str"><f>"ca"&amp;"ched"</f><v>cached</v></c><c r="B5"><f>1+1</f><v>2</v></c><c r="C5" s="1"/></row>',
    // B6 is covered by the A6:B6 merge, so its value is not shown, as in Excel.
    '<row r="6"><c r="A6" t="s"><v>4</v></c><c r="B6" t="s"><v>2</v></c><c r="C6"><v>99</v></c></row>',
    '<row r="7"><c r="A7" t="d"><v>2026-04-01T00:00:00</v></c></row>',
  ].join(''),
  '<mergeCells count="2"><mergeCell ref="A6:B6"/><mergeCell ref="C6:C7"/></mergeCells>',
);
const hidden = sheet('<row r="1"><c r="A1" t="s"><v>5</v></c><c r="B1"><v>7</v></c></row>');
const veryHidden = sheet('<row r="2"><c r="B2" t="inlineStr"><is><t>secret</t></is></c></row>');

const files = {
  '[Content_Types].xml': xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/></Types>`,
  ),
  '_rels/.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  ),
  'xl/workbook.xml': xml(
    `<workbook xmlns="${S}" xmlns:r="${R}"><workbookPr/><sheets><sheet name="Data" sheetId="1" r:id="rIdData"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rIdHidden"/><sheet name="VeryHidden" sheetId="3" state="veryHidden" r:id="rIdVery"/></sheets></workbook>`,
  ),
  'xl/_rels/workbook.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rIdVery" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rIdHidden" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rIdData" Type="${R}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rIdStrings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  ),
  'xl/sharedStrings.xml': xml(
    `<sst xmlns="${S}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.join('')}</sst>`,
  ),
  'xl/worksheets/sheet1.xml': veryHidden,
  'xl/worksheets/sheet2.xml': hidden,
  'xl/worksheets/sheet3.xml': data,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/xlsx/cell-types.xlsx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/xlsx/cell-types.xlsx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-xlsx-cells.mjs\nRequirements: XLS-1, XLS-2, XLS-5, XLS-7\nNotes: visible, hidden and very hidden sheets in an order that differs from part names; shared, rich, inline and phonetic strings; booleans, an error, numbers, cached formula values, an ISO date cell and merged cells.\n',
);

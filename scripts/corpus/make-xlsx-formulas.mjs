import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made workbook (CC0-1.0) with simple, shared and array formulas, written from ECMA-376
// Part 1, 18.3.1.40 (f). Cached values are deliberate: D1 holds =1+1 with the cached value 5, so
// any evaluation would show.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${body}`;

const calc = [
  '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><v>3</v></c><c r="C1"><f>A1+B1</f><v>5</v></c><c r="D1"><f>1+1</f><v>5</v></c><c r="E1"><f t="array" ref="E1:E3">ROW(A1:A3)*2</f><v>2</v></c><c r="F1"><f>Other!A1+\'My Sheet\'!B2</f><v>11</v></c><c r="G1"><f>A1*10</f></c><c r="H1" t="str"><f>"A1="&amp;A1</f><v>A1=2</v></c></row>',
  '<row r="2"><c r="A2"><v>10</v></c><c r="B2"><v>100</v></c><c r="C2"><f t="shared" ref="C2:C4" si="0">A2*$B$1+LOG10(B2)</f><v>32</v></c><c r="E2"><v>4</v></c></row>',
  '<row r="3"><c r="A3"><v>20</v></c><c r="B3"><v>1000</v></c><c r="C3"><f t="shared" si="0"/><v>63</v></c><c r="E3"><v>6</v></c></row>',
  '<row r="4"><c r="A4"><v>30</v></c><c r="B4"><v>10</v></c><c r="C4"><f t="shared" si="0"/><v>91</v></c></row>',
  '<row r="5"><c r="A5"><v>1</v></c><c r="B5"><v>2</v></c><c r="C5"><v>3</v></c></row>',
  '<row r="6"><c r="A6"><f t="shared" ref="A6:C6" si="1">A5+1</f><v>2</v></c><c r="B6"><f t="shared" si="1"/><v>3</v></c><c r="C6"><f t="shared" si="1"/><v>4</v></c></row>',
].join('');
const other = '<row r="1"><c r="A1"><v>5</v></c></row>';
const mySheet = '<row r="2"><c r="B2"><v>6</v></c></row>';
const worksheet = (rows) => xml(`<worksheet xmlns="${S}"><sheetData>${rows}</sheetData></worksheet>`);

const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
const files = {
  '[Content_Types].xml': xml(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="${CT}.worksheet+xml"/></Types>`,
  ),
  '_rels/.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  ),
  'xl/workbook.xml': xml(
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Calc" sheetId="1" r:id="rId1"/><sheet name="Other" sheetId="2" r:id="rId2"/><sheet name="My Sheet" sheetId="3" r:id="rId3"/></sheets></workbook>`,
  ),
  'xl/_rels/workbook.xml.rels': xml(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${R}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${R}/worksheet" Target="worksheets/sheet3.xml"/></Relationships>`,
  ),
  'xl/worksheets/sheet1.xml': worksheet(calc),
  'xl/worksheets/sheet2.xml': worksheet(other),
  'xl/worksheets/sheet3.xml': worksheet(mySheet),
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/xlsx/formulas.xlsx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/xlsx/formulas.xlsx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-xlsx-formulas.mjs\nRequirements: XLS-4, SEC-11\nNotes: simple, shared (vertical and horizontal), array, cross-sheet and string formulas with cached values; =1+1 cached as 5; one formula without a cached value.\n',
);

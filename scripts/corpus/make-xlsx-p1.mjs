import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made spreadsheet P1 fixtures (CC0-1.0), written from ECMA-376 Part 1 (18.3 worksheets,
// 18.5 tables, 18.7 comments, 18.2.5 defined names) and [MS-XLSX] 2.6 for threaded comments.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const TC = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const MS_REL = 'http://schemas.microsoft.com/office/2017/10/relationships';
const MTIME = new Date('1980-01-01T00:00:00Z');

const escape = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
/** A cell: strings are inline, numbers plain, booleans `t="b"`; `{ value, style }` sets a style. */
function cell(ref, value) {
  const style = typeof value === 'object' && value !== null ? ` s="${value.style}"` : '';
  const raw = typeof value === 'object' && value !== null ? value.value : value;
  if (typeof raw === 'string') return `<c r="${ref}" t="inlineStr"${style}><is><t>${escape(raw)}</t></is></c>`;
  if (typeof raw === 'boolean') return `<c r="${ref}" t="b"${style}><v>${raw ? 1 : 0}</v></c>`;
  return `<c r="${ref}"${style}><v>${raw}</v></c>`;
}
const column = (index) => String.fromCharCode(65 + index);
/** Rows from a grid of values starting at `top`/`left`; `null` leaves a cell out. */
function rows(grid, { top = 1, left = 0, hidden = new Set() } = {}) {
  return grid
    .map((values, offset) => {
      const row = top + offset;
      const cells = values
        .map((value, index) => (value === null ? '' : cell(`${column(left + index)}${row}`, value)))
        .join('');
      return `<row r="${row}"${hidden.has(row) ? ' hidden="1"' : ''}>${cells}</row>`;
    })
    .join('');
}

/**
 * A workbook: sheets of `{ name, data, before, after, rels, parts }`, plus workbook `definedNames`,
 * workbook-level `parts` and `rels`, and `styles`.
 */
function workbook({ sheets, definedNames = '', parts = {}, rels = '', types = '', styles }) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${types}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${S}" xmlns:r="${R}"><sheets>${sheets.map((sheet, index) => `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rIdSheet${index + 1}"/>`).join('')}</sheets>${definedNames ? `<definedNames>${definedNames}</definedNames>` : ''}</workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${sheets.map((_, index) => `<Relationship Id="rIdSheet${index + 1}" Type="${R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}${styles ? `<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>` : ''}${rels}</Relationships>`,
    ...(styles ? { 'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${S}">${styles}</styleSheet>` } : {}),
    ...parts,
  };
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${S}" xmlns:r="${R}">${sheet.before ?? ''}<sheetData>${sheet.data}</sheetData>${sheet.after ?? ''}</worksheet>`;
    if (sheet.rels)
      files[`xl/worksheets/_rels/sheet${index + 1}.xml.rels`] =
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${sheet.rels}</Relationships>`;
    Object.assign(files, sheet.parts ?? {});
  });
  const entries = Object.create(null);
  for (const [name, data] of Object.entries(files)) entries[name] = [strToU8(data), { mtime: MTIME }];
  return zipSync(entries, { level: 9 });
}

async function save(name, bytes, requirements, notes) {
  await writeFile(new URL(`../../corpus/xlsx/${name}`, import.meta.url), bytes);
  await writeFile(
    new URL(`../../corpus/xlsx/${name}.license`, import.meta.url),
    `SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-xlsx-p1.mjs\nRequirements: ${requirements}\nNotes: ${notes}\n`,
  );
}

// XLS-8: header guesses. Style 1 is the built-in date format 14.
await save(
  'header-detection.xlsx',
  workbook({
    styles:
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs>',
    sheets: [
      {
        name: 'Typed',
        data: rows([
          ['Item', 'Price', 'Due', 'Paid'],
          ['Pump', 120.5, { value: 46156, style: 1 }, true],
          ['Valve', 35, { value: 46157, style: 1 }, false],
        ]),
      },
      {
        name: 'Text only',
        data: rows([
          ['Name', 'Role'],
          ['Ada', 'Engineer'],
          ['Grace', 'Admiral'],
        ]),
      },
      {
        name: 'Numeric header',
        data: rows([
          ['Region', 2024, 2025],
          ['North', 10, 12],
          ['South', 8, 9],
        ]),
      },
      {
        name: 'Title row',
        data: rows([
          ['Quarterly totals', null, null, null],
          [1, 2, 3, 4],
          [5, 6, 7, 8],
        ]),
      },
    ],
  }),
  'XLS-8',
  'a typed table with a text header (header), a text-only table, a numeric first row and a title row over numbers (no header).',
);

// XLS-9: legacy notes, a threaded comment with a reply and its legacy placeholder, a phonetic run.
await save(
  'comments.xlsx',
  workbook({
    types: `<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>`,
    rels: `<Relationship Id="rIdPersons" Type="${MS_REL}/person" Target="persons/person.xml"/>`,
    parts: {
      'xl/persons/person.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><personList xmlns="${TC}"><person displayName="Ada Reviewer" id="{00000000-0000-0000-0000-000000000001}" userId="ada" providerId="None"/><person displayName="Grace Approver" id="{00000000-0000-0000-0000-000000000002}" userId="grace" providerId="None"/></personList>`,
    },
    sheets: [
      {
        name: 'Budget',
        data: rows([
          ['Item', 'Cost'],
          ['Pump', 120],
          ['Valve', 35],
        ]),
        rels:
          `<Relationship Id="rIdC" Type="${R}/comments" Target="../comments1.xml"/>` +
          `<Relationship Id="rIdT" Type="${MS_REL}/threadedComment" Target="../threadedComments/threadedComment1.xml"/>`,
        parts: {
          'xl/comments1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><comments xmlns="${S}"><authors><author>Ada Reviewer</author><author>tc={00000000-0000-0000-0000-0000000000AA}</author></authors><commentList><comment ref="B2" authorId="0"><text><r><rPr><b/></rPr><t>Ada Reviewer:</t></r><r><t xml:space="preserve">\nIncludes the spare seal.</t></r></text></comment><comment ref="a3" authorId="0"><text><t>Check the supplier.</t><rPh sb="0" eb="1"><t>phonetic</t></rPh></text></comment><comment ref="A1" authorId="1"><text><t>[Threaded comment] Your version of Excel lets you read this threaded comment.</t></text></comment></commentList></comments>`,
          'xl/threadedComments/threadedComment1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ThreadedComments xmlns="${TC}"><threadedComment ref="A1" dT="2026-05-14T10:00:00.00" personId="{00000000-0000-0000-0000-000000000001}" id="{00000000-0000-0000-0000-0000000000AA}"><text>Should we split labour from parts?</text></threadedComment><threadedComment ref="A1" dT="2026-05-14T11:00:00.00" personId="{00000000-0000-0000-0000-000000000002}" id="{00000000-0000-0000-0000-0000000000AB}" parentId="{00000000-0000-0000-0000-0000000000AA}"><text>Yes, next quarter.</text></threadedComment></ThreadedComments>`,
        },
      },
    ],
  }),
  'XLS-9',
  'two legacy notes (one with a phonetic run), a threaded comment with a reply and authors from the person list, and the legacy placeholder Excel writes for it.',
);

// XLS-9: an Excel table and defined names, matching regions or not.
await save(
  'tables-names.xlsx',
  workbook({
    definedNames:
      '<definedName name="Rates">Data!$F$1:$G$3</definedName>' +
      '<definedName name="TopTwo">Data!$A$2:$C$3</definedName>' +
      '<definedName name="_xlnm.Print_Area" localSheetId="0">Data!$A$1:$C$4</definedName>' +
      '<definedName name="Secret" hidden="1">Data!$A$1:$B$2</definedName>' +
      '<definedName name="TwoAreas">Data!$A$1:$A$2,Data!$C$1:$C$2</definedName>' +
      '<definedName name="TaxRate">0.2</definedName>' +
      '<definedName name="Broken">#REF!$A$1</definedName>' +
      `<definedName name="Odd">'Odd ''Name'''!$A$1:$B$2</definedName>` +
      '<definedName name="Outside">Data!$A$20:$C$30</definedName>',
    sheets: [
      {
        name: 'Data',
        data:
          rows([
            ['Region', 'Units', 'Revenue', null, null, 'Code', 'Rate'],
            ['North', 10, 1200, null, null, 'A', 0.1],
            ['South', 8, 950, null, null, 'B', 0.2],
            ['East', 12, 1430],
          ]) + rows([['Summary row'], ['Total', 30, 3580]], { top: 7 }),
        rels: `<Relationship Id="rIdTable" Type="${R}/table" Target="../tables/table1.xml"/><Relationship Id="rIdTable2" Type="${R}/table" Target="../tables/table2.xml"/>`,
        parts: {
          'xl/tables/table1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="${S}" id="1" name="Table1" displayName="Sales" ref="A1:C4" headerRowCount="1" totalsRowShown="0"><autoFilter ref="A1:C4"/><tableColumns count="3"><tableColumn id="1" name="Region"/><tableColumn id="2" name="Units"/><tableColumn id="3" name="Revenue"/></tableColumns></table>`,
          'xl/tables/table2.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><table xmlns="${S}" id="2" name="Totals" ref="A7:C8" headerRowCount="0"><tableColumns count="3"><tableColumn id="1" name="Column1"/><tableColumn id="2" name="Column2"/><tableColumn id="3" name="Column3"/></tableColumns></table>`,
        },
      },
      {
        name: "Odd 'Name'",
        data: rows([
          ['Key', 'Value'],
          ['k', 1],
        ]),
      },
    ],
  }),
  'XLS-9',
  'an Excel table matching a region, one with no header row, defined names matching a region, inside a region, on a quoted sheet name and outside the used cells, and names that are not one range (built-in, hidden, two areas, a constant, #REF!).',
);

// XLS-10: hidden rows and columns are kept and flagged.
await save(
  'hidden-rows-columns.xlsx',
  workbook({
    sheets: [
      {
        name: 'Inventory',
        before:
          '<cols><col min="2" max="2" width="0" hidden="1"/><col min="4" max="5" hidden="1"/><col min="3" max="3" width="12"/></cols>',
        data: rows(
          [
            ['Part', 'Internal code', 'Stock', 'Cost', 'Margin'],
            ['Pump', 'P-01', 4, 80, 0.3],
            ['Old pump', 'P-00', 0, 70, 0.1],
            ['Valve', 'V-07', 12, 20, 0.4],
          ],
          { hidden: new Set([3]) },
        ),
      },
    ],
  }),
  'XLS-10',
  'a hidden column, a hidden two-column range and a hidden row, all with values.',
);

import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile XLSX packages: a claimed full grid, sparse corners, a shared-string flood and
// prototype-named sheets, relationship ids and references.
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const directory = new URL('../../hostile/xlsx/', import.meta.url);
await mkdir(directory, { recursive: true });

/** `sheets` is a list of [name, relationship id, worksheet XML]. */
function xlsx(sheets, sharedStrings, styles) {
  const entries = sheets.map(([name, id]) => `<sheet name="${name}" sheetId="1" r:id="${id}"/>`).join('');
  const relationships = sheets
    .map(
      ([, id], index) =>
        `<Relationship Id="${id}" Type="${R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${entries}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG}">${relationships}<Relationship Id="strings" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  };
  if (sharedStrings !== undefined) files['xl/sharedStrings.xml'] = `<sst xmlns="${S}">${sharedStrings}</sst>`;
  if (styles !== undefined) {
    files['xl/_rels/workbook.xml.rels'] = files['xl/_rels/workbook.xml.rels'].replace(
      '</Relationships>',
      `<Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    );
    files['xl/styles.xml'] = `<styleSheet xmlns="${S}">${styles}</styleSheet>`;
  }
  sheets.forEach(([, , xml], index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = xml;
  });
  const zipEntries = Object.create(null);
  for (const [name, content] of Object.entries(files)) {
    zipEntries[name] = [strToU8(content), { mtime: new Date('1980-01-01T00:00:00Z') }];
  }
  return zipSync(zipEntries, { level: 9 });
}

const worksheet = (rows, extra = '', before = '') =>
  `<worksheet xmlns="${S}">${before}<sheetData>${rows}</sheetData>${extra}</worksheet>`;

// Claims all 1,048,576 x 16,384 cells through its dimension and one merge: stops at `cells`.
await writeFile(
  new URL('claimed-full-grid.xlsx', directory),
  xlsx([
    [
      'Grid',
      'rId1',
      worksheet(
        '<row r="1"><c r="A1"><v>1</v></c></row>',
        '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>',
        '<dimension ref="A1:XFD1048576"/>',
      ),
    ],
  ]),
);

// Values in the four corners of the grid: four one-cell tables, not 17 billion cells.
await writeFile(
  new URL('sparse-corners.xlsx', directory),
  xlsx([
    [
      'Corners',
      'rId1',
      worksheet(
        '<row r="1"><c r="A1"><v>1</v></c><c r="XFD1"><v>2</v></c></row><row r="1048576"><c r="A1048576"><v>3</v></c><c r="XFD1048576"><v>4</v></c></row>',
        '',
        '<dimension ref="A1:XFD1048576"/>',
      ),
    ],
  ]),
);

// Three million empty shared strings in a small archive: the compression-ratio limit stops it.
await writeFile(
  new URL('shared-string-bomb.xlsx', directory),
  xlsx(
    [['Flood', 'rId1', worksheet('<row r="1"><c r="A1" t="s"><v>2999999</v></c></row>')]],
    '<si/>'.repeat(3_000_000),
  ),
);

// Prototype-named sheets and relationship ids, a huge shared-string index, bad references and merges.
await writeFile(
  new URL('proto-names.xlsx', directory),
  xlsx(
    [
      [
        '__proto__',
        '__proto__',
        worksheet(
          '<row r="__proto__"><c r="constructor" t="s"><v>99999999999999999999</v></c><c r="A0"><v>1</v></c><c r="XFE1"><v>2</v></c><c t="__proto__"><v>toString</v></c></row>',
          '<mergeCells><mergeCell ref="__proto__"/><mergeCell ref="A1:A1"/><mergeCell ref="B1:A1"/></mergeCells>',
        ),
      ],
      [
        'constructor',
        'constructor',
        worksheet('<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>'),
      ],
    ],
    '<si><t>__proto__</t></si>',
  ),
);

// Number-format oddities: a 3,000-character code, nested brackets, a huge elapsed serial,
// prototype-named and missing format ids, and style indexes past the end of cellXfs.
const formats = [
  ['164', `${'0'.repeat(3000)}`],
  ['165', '[[[[[[h]]]]]]:mm;[<<<0]"x";[Red][Blue][Green]0;@@@@'],
  ['166', '[h]:mm:ss.000'],
  ['__proto__', 'yyyy'],
  ['167', '0.' + '0'.repeat(400) + 'E+' + '0'.repeat(400)],
  ['168', '# ' + '?'.repeat(300) + '/' + '?'.repeat(300)],
];
const attribute = (text) => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const numFmts = formats
  .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${attribute(code)}"/>`)
  .join('');
const cellXfs = ['164', '165', '166', '999', 'constructor', '167', '168']
  .map((id) => `<xf numFmtId="${id}"/>`)
  .join('');
const cells = [
  '<c r="A1" s="0"><v>1</v></c>',
  '<c r="B1" s="1"><v>-5</v></c>',
  '<c r="C1" s="2"><v>9999999999</v></c>',
  '<c r="D1" s="3"><v>2</v></c>',
  '<c r="E1" s="4"><v>3</v></c>',
  '<c r="F1" s="5"><v>1e300</v></c>',
  '<c r="G1" s="6"><v>0.123456789</v></c>',
  '<c r="H1" s="99999999"><v>4</v></c>',
  '<c r="I1" s="1" t="inlineStr"><is><t>__proto__</t></is></c>',
].join('');
await writeFile(
  new URL('format-oddities.xlsx', directory),
  xlsx(
    [['Formats', 'rId1', worksheet(`<row r="1">${cells}</row>`)]],
    undefined,
    `<numFmts>${numFmts}</numFmts><cellXfs>${cellXfs}</cellXfs>`,
  ),
);

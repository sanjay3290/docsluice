import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made WordprocessingML table cases (CC0-1.0), written from ECMA-376 Part 1, 17.4.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const p = (text, style = '') =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const item = (text) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;
const tc = (content, props = '') => `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${content}</w:tc>`;
const tr = (cells, header = false) => `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
const tbl = (rows) => `<w:tbl>${rows}</w:tbl>`;
const span = (n) => `<w:gridSpan w:val="${n}"/>`;
const restart = '<w:vMerge w:val="restart"/>';
const cont = '<w:vMerge/>';

const body = [
  p('Table cases', 'Heading1'),
  p('Horizontal merge with two header rows'),
  tbl(
    tr(tc(p('Quarter'), span(3)), true) +
      tr(tc(p('Region')) + tc(p('Q1')) + tc(p('Q2')), true) +
      tr(tc(p('North')) + tc(p('12')) + tc(p('15'))) +
      tr(tc(p('Total across quarters'), span(2)) + tc(p('27'))),
  ),
  p('Vertical merge'),
  tbl(
    tr(tc(p('Group A'), restart) + tc(p('alpha'))) +
      tr(tc(p(''), cont) + tc(p('beta'))) +
      tr(tc(p(''), cont) + tc(p('gamma'))) +
      tr(tc(p('Group B')) + tc(p('delta'))),
  ),
  p('Horizontal and vertical merge together'),
  tbl(
    tr(tc(p('Block'), span(2) + restart) + tc(p('right 1'))) +
      tr(tc(p(''), span(2) + cont) + tc(p('right 2'))) +
      tr(tc(p('a')) + tc(p('b')) + tc(p('c'))),
  ),
  p('Nested three deep'),
  tbl(
    tr(
      tc(p('Level 1') + tbl(tr(tc(p('Level 2') + tbl(tr(tc(p('Level 3') + tbl(tr(tc(p('Level 4 core')))))))) + tc(p('L2 side'))))) +
        tc(p('L1 side')),
    ),
  ),
  p('A list right before a table'),
  item('First step'),
  item('Second step'),
  tbl(tr(tc(p('Table after the list')))),
  p('Closing paragraph.'),
].join('');

const numbering = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rIdNumbering" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  'word/numbering.xml': numbering,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/docx/tables.docx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/docx/tables.docx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-docx-tables.mjs\nRequirements: DOC-4\nNotes: horizontal merge with header rows, vertical merge, both together, tables nested three deep, and a numbered list ending right before a table.\n',
);

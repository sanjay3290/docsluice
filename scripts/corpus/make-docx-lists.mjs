import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made WordprocessingML numbering cases (CC0-1.0), written from ECMA-376 Part 1, 17.9.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

const lvl = (ilvl, numFmt, lvlText, extra = '') =>
  `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${numFmt}"/><w:lvlText w:val="${lvlText}"/>${extra}</w:lvl>`;
const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="10">${lvl(0, 'decimal', '%1.')}${lvl(1, 'decimal', '%1.%2.')}${lvl(2, 'decimal', '%1.%2.%3.')}</w:abstractNum>
<w:abstractNum w:abstractNumId="20">${lvl(0, 'lowerLetter', '%1)')}${lvl(1, 'lowerRoman', '%2.')}${lvl(2, 'upperRoman', '%3.')}</w:abstractNum>
<w:abstractNum w:abstractNumId="30">${lvl(0, 'bullet', '')}${lvl(1, 'bullet', 'o')}${lvl(2, 'bullet', '')}</w:abstractNum>
<w:abstractNum w:abstractNumId="40">${lvl(0, 'decimal', '%1.')}${lvl(1, 'bullet', '')}${lvl(2, 'decimalZero', '%3)')}</w:abstractNum>
<w:abstractNum w:abstractNumId="50">${lvl(0, 'upperLetter', 'Article %1')}${lvl(1, 'ordinal', '%2')}</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
<w:num w:numId="3"><w:abstractNumId w:val="20"/></w:num>
<w:num w:numId="4"><w:abstractNumId w:val="30"/></w:num>
<w:num w:numId="5"><w:abstractNumId w:val="40"/></w:num>
<w:num w:numId="6"><w:abstractNumId w:val="20"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="4"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:lvlOverride></w:num>
<w:num w:numId="7"><w:abstractNumId w:val="50"/></w:num>
</w:numbering>`;

const p = (text, numId, ilvl = 0, style = '') =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${numId === undefined ? '' : `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

const body = [
  p('Numbering cases', undefined, 0, 'Heading1'),
  p('Legal numbering', undefined),
  p('Scope', 1, 0),
  p('Definitions', 1, 1),
  p('Terms', 1, 2),
  p('Abbreviations', 1, 2),
  p('Interpretation', 1, 1),
  p('Obligations', 1, 0),
  p('Payment', 1, 1),
  p('A plain paragraph ends the list; the next numbered item continues the count.', undefined),
  p('Termination', 1, 0),
  p('Restarted with a start override', undefined),
  p('First again', 2, 0),
  p('Second again', 2, 0),
  p('Letters and roman numerals', undefined),
  p('Alpha', 3, 0),
  p('Detail one', 3, 1),
  p('Detail two', 3, 1),
  p('Deep point', 3, 2),
  p('Beta', 3, 0),
  p('Bullets', undefined),
  p('Round', 4, 0),
  p('Hollow', 4, 1),
  p('Square', 4, 2),
  p('Mixed numbers and bullets', undefined),
  p('Step one', 5, 0),
  p('Note under step one', 5, 1),
  p('Sub-step', 5, 2),
  p('Step two', 5, 0),
  p('Level override with a start of four', undefined),
  p('Fourth letter', 6, 0),
  p('Fifth letter', 6, 0),
  p('Inherited from the paragraph style', undefined),
  p('Styled item one', undefined, 0, 'ListItemStyle'),
  p('Styled item two', undefined, 0, 'ListItemStyle'),
  p('numId 0 removes the inherited numbering.', 0, 0, 'ListItemStyle'),
  p('Numbered heading keeps its level', 7, 0, 'Heading2'),
  p('Ordinal under the heading', 7, 1),
  p('Second ordinal', 7, 1),
].join('');

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="ListBase"><w:name w:val="List Base"/><w:pPr><w:numPr><w:numId w:val="4"/></w:numPr></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ListItemStyle"><w:name w:val="List Item Style"/><w:basedOn w:val="ListBase"/></w:style>
</w:styles>`;

const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
  'word/styles.xml': styles,
  'word/numbering.xml': numbering,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/docx/numbering.docx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/docx/numbering.docx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-docx-lists.mjs\nRequirements: DOC-3\nNotes: legal multi-level numbering, continuation across list blocks, startOverride restart, level override, letters, roman numerals, ordinals, decimalZero, Symbol-font bullets, mixed lists, style-inherited numbering, numId 0, and a numbered heading.\n',
);

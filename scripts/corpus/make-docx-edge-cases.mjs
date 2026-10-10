import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made WordprocessingML edge cases (CC0-1.0), written from ECMA-376 Part 1 rather than exported by a tool.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const WPS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const p = (text, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const style = (id, props = "") => `<w:pStyle w:val="${id}"/>${props}`;

const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:mc="${MC}" xmlns:wps="${WPS}" mc:Ignorable="wps"><w:body>
${p('Edge cases for the DOCX reader', style('Title'))}
${p('Localized heading style', style('berschrift1'))}
${p('Custom style inherits an outline level', style('ReportSection'))}
<w:sdt><w:sdtPr><w:alias w:val="Plot"/></w:sdtPr><w:sdtContent>${p('Content control text stays in order.')}</w:sdtContent></w:sdt>
<w:p><w:r><w:t xml:space="preserve">Anchor before the box. </w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent>${p('Text box text appears once.')}</w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent>${p('Text box text appears once.')}</w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink w:anchor="results"><w:r><w:t>the results</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> and </w:t></w:r><w:hyperlink r:id="rIdSite"><w:r><w:t>the project site</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
<w:p><w:bookmarkStart w:id="0" w:name="results"/><w:r><w:t xml:space="preserve">Results: page </w:t></w:r><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:bookmarkEnd w:id="0"/></w:p>
<w:tbl><w:tr><w:tc>${p('Cell text one')}</w:tc><w:tc>${p('Cell text two')}</w:tc></w:tr></w:tbl>
${p('Closing paragraph.')}
</w:body></w:document>`;

const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="SectionBase"><w:name w:val="Section Base"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="ReportSection"><w:name w:val="Report Section"/><w:basedOn w:val="SectionBase"/></w:style>
</w:styles>`;

const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rIdSite" Type="${R}/hyperlink" Target="https://example.invalid/project" TargetMode="External"/></Relationships>`,
  'word/document.xml': document,
  'word/styles.xml': styles,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
const output = new URL('../../corpus/docx/edge-cases.docx', import.meta.url);
await writeFile(output, zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/docx/edge-cases.docx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-docx-edge-cases.mjs\nRequirements: DOC-1, DOC-2, DOC-7\nNotes: AlternateContent text box (one branch), content control, localized and inherited outline-level heading styles, internal anchor and external hyperlink, simple field, table text.\n',
);

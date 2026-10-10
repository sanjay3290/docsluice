import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { writeCfb } from '../../packages/docsluice/src/ole/write.ts';

// Hand-made Word P1 fixtures (CC0-1.0), written from ECMA-376 Part 1: hidden text (17.3.2.41
// vanish), fields (17.16), Office Math (22.1) and embedded objects (17.3.3.19, VML o:OLEObject).
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const M = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
const V = 'urn:schemas-microsoft-com:vml';
const O = 'urn:schemas-microsoft-com:office:office';
const MAIN = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const STYLES = 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml';
const MTIME = new Date('1980-01-01T00:00:00Z');
const budget = { tick() {}, checkUncompressed: () => true, addUncompressed: () => true };

const t = (text) => `<w:t xml:space="preserve">${text}</w:t>`;
const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${t(text)}</w:r>`;
const p = (inner, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${inner}</w:p>`;
const heading = (text) => p(run(text), '<w:pStyle w:val="Heading1"/>');
const fieldChar = (type) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`;
const instr = (code) => `<w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r>`;
const field = (code, result) =>
  fieldChar('begin') + instr(code) + fieldChar('separate') + run(result) + fieldChar('end');

const headingStyle =
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>';

function zip(files) {
  const entries = Object.create(null);
  for (const [name, data] of Object.entries(files))
    entries[name] = [typeof data === 'string' ? strToU8(data) : data, { mtime: MTIME }];
  return zipSync(entries, { level: 9 });
}

function docx({ body, styles, rels = '', types = '', parts = {}, namespaces = '' }) {
  const styleRel = styles ? `<Relationship Id="rIdStyles" Type="${R}/styles" Target="styles.xml"/>` : '';
  return zip({
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${types}<Override PartName="/word/document.xml" ContentType="${MAIN}"/>${styles ? `<Override PartName="/word/styles.xml" ContentType="${STYLES}"/>` : ''}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}">${styleRel}${rels}</Relationships>`,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}"${namespaces}><w:body>${body}</w:body></w:document>`,
    ...(styles
      ? {
          'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}">${headingStyle}${styles}</w:styles>`,
        }
      : {}),
    ...parts,
  });
}

async function save(name, bytes, requirements, notes) {
  await writeFile(new URL(`../../corpus/docx/${name}`, import.meta.url), bytes);
  await writeFile(
    new URL(`../../corpus/docx/${name}.license`, import.meta.url),
    `SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-docx-p1.mjs\nRequirements: ${requirements}\nNotes: ${notes}\n`,
  );
}

// DOC-9: direct, character-style and paragraph-style hidden text, and a direct override.
await save(
  'hidden-text.docx',
  docx({
    styles:
      '<w:style w:type="character" w:styleId="SecretChar"><w:name w:val="Secret Char"/><w:rPr><w:vanish/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="SecretBased"><w:name w:val="Secret Based"/><w:basedOn w:val="SecretChar"/></w:style>' +
      '<w:style w:type="paragraph" w:styleId="HiddenNote"><w:name w:val="Hidden Note"/><w:rPr><w:vanish/></w:rPr></w:style>',
    body: [
      heading('Hidden text'),
      p(run('Visible start, ') + run('a direct secret, ', '<w:vanish/>') + run('visible end.')),
      p(run('Style: ') + run('a styled secret ', '<w:rStyle w:val="SecretChar"/>') + run('and ') + run('an inherited secret.', '<w:rStyle w:val="SecretBased"/>')),
      p(run('Override: ') + run('shown despite its hidden style.', '<w:rStyle w:val="SecretChar"/><w:vanish w:val="0"/>')),
      p(run('This whole paragraph is hidden by its style.'), '<w:pStyle w:val="HiddenNote"/>'),
      p(run('Except this run, ') + run('which turns hidden off.', '<w:vanish w:val="false"/>'), '<w:pStyle w:val="HiddenNote"/>'),
      p(run('Closing visible paragraph.')),
    ].join(''),
  }),
  'DOC-9',
  'w:vanish on runs, through a character style and its basedOn child, through a paragraph style, and turned off directly.',
);

// DOC-10: complex fields show their result only; nested fields in a field code stay out.
await save(
  'fields.docx',
  docx({
    styles: '',
    body: [
      heading('Fields'),
      p(run('Page ') + field(' PAGE ', '3') + run(' of ') + field(' NUMPAGES ', '12') + run('.')),
      p(run('Printed on ') + field(' DATE \\@ "d MMMM yyyy" ', '14 May 2026') + run('.')),
      p(run('Author: ') + `<w:fldSimple w:instr=" AUTHOR \\* MERGEFORMAT "><w:r>${t('Ada Author')}</w:r></w:fldSimple>` + run('.')),
      p(run('Dear ') + field(' MERGEFIELD FirstName ', '«FirstName»') + run(',')),
      p(
        run('Plan: ') +
          fieldChar('begin') +
          instr(' IF ') +
          field(' MERGEFIELD Plan ', 'Gold') +
          instr(' = "Gold" "Premium" "Standard" ') +
          fieldChar('separate') +
          run('Premium') +
          fieldChar('end') +
          run('.'),
      ),
      p(run('No result: [') + fieldChar('begin') + instr(' SEQ Figure ') + fieldChar('end') + run('].')),
      p(fieldChar('begin') + instr(' TOC \\o "1-3" ') + fieldChar('separate') + run('Introduction\u00a01')),
      p(run('Results\u00a02') + fieldChar('end')),
      p(run('See ') + field(' HYPERLINK "https://example.invalid/docs" ', 'the guide') + run('.')),
    ].join(''),
  }),
  'DOC-10',
  'PAGE, NUMPAGES, DATE, MERGEFIELD and HYPERLINK complex fields, an AUTHOR fldSimple, an IF field with a nested field in its code, a field with no result, and a TOC field across paragraphs.',
);

// DOC-11: Office Math in the linear text form.
const mr = (text) => `<m:r>${text.length ? `<m:t>${text}</m:t>` : ''}</m:r>`;
const arg = (name, inner) => `<m:${name}>${inner}</m:${name}>`;
const frac = (num, den) => `<m:f>${arg('num', num)}${arg('den', den)}</m:f>`;
const sup = (base, power) => `<m:sSup>${arg('e', base)}${arg('sup', power)}</m:sSup>`;
const sub = (base, index) => `<m:sSub>${arg('e', base)}${arg('sub', index)}</m:sSub>`;
const subSup = (base, index, power) =>
  `<m:sSubSup>${arg('e', base)}${arg('sub', index)}${arg('sup', power)}</m:sSubSup>`;
const rad = (inner, degree = '') =>
  `<m:rad><m:radPr>${degree ? '' : '<m:degHide m:val="1"/>'}</m:radPr>${arg('deg', degree)}${arg('e', inner)}</m:rad>`;
const nary = (chr, lower, upper, inner) =>
  `<m:nary><m:naryPr>${chr ? `<m:chr m:val="${chr}"/>` : ''}<m:limLoc m:val="undOvr"/></m:naryPr>${arg('sub', lower)}${arg('sup', upper)}${arg('e', inner)}</m:nary>`;
const delim = (items, props = '') => `<m:d><m:dPr>${props}</m:dPr>${items.map((item) => arg('e', item)).join('')}</m:d>`;
const matrix = (rows) => `<m:m>${rows.map((row) => `<m:mr>${row.map((cell) => arg('e', mr(cell))).join('')}</m:mr>`).join('')}</m:m>`;
const func = (name, inner) => `<m:func>${arg('fName', mr(name))}${arg('e', inner)}</m:func>`;
const math = (inner) => `<m:oMath>${inner}</m:oMath>`;

await save(
  'equations.docx',
  docx({
    namespaces: ` xmlns:m="${M}"`,
    styles: '',
    body: [
      heading('Equations'),
      p(
        run('The roots are ') +
          math(mr('x=') + frac(mr('−b±') + rad(sup(mr('b'), mr('2')) + mr('−4ac')), mr('2a'))) +
          run('.'),
      ),
      `<w:p><m:oMathPara>${math(nary('∑', mr('i=1'), mr('n'), mr('i')) + mr('=') + frac(mr('n') + delim([mr('n+1')]), mr('2')))}</m:oMathPara></w:p>`,
      p(run('Indices: ') + math(sub(mr('x'), mr('1')) + mr('+') + subSup(mr('a'), mr('i'), mr('2')) + mr(', ') + rad(mr('x'), mr('3')))),
      p(run('Identity: ') + math(mr('I=') + delim([matrix([['1', '0'], ['0', '1']])]))),
      p(run('Calculus: ') + math(nary('', mr('0'), mr('1'), sup(mr('x'), mr('2')) + mr('dx')) + mr(', ') + func('sin', mr('θ')) + mr(', ') + `<m:limLow>${arg('e', mr('lim'))}${arg('lim', mr('n→∞'))}</m:limLow>` + sup(mr('a'), mr('n')))),
      p(run('Brackets: ') + math(delim([mr('a'), mr('b')], '<m:begChr m:val="["/><m:endChr m:val="]"/><m:sepChr m:val=";"/>') + mr(', ') + `<m:acc><m:accPr><m:chr m:val="&#x0302;"/></m:accPr>${arg('e', mr('x'))}</m:acc>`)),
    ].join(''),
  }),
  'DOC-11',
  'Office Math: fraction, radicals with and without a degree, sum and integral, scripts, delimiters, a matrix, a function, a lower limit and an accent, inline and in an oMathPara.',
);

// DOC-12, NST-1: an embedded workbook part, an OLE .bin whose Package stream holds a document, and a link.
const workbook = zip({
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${R}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Pump</t></is></c><c r="B2"><v>120</v></c></row></sheetData></worksheet>`,
});
const inner = docx({ body: p(run('Text of the document packaged inside an OLE object.')) });
const oleObject = writeCfb(
  [
    { path: '\u0001CompObj', type: 'stream', data: new Uint8Array(0) },
    { path: 'Package', type: 'stream', data: inner },
  ],
  budget,
);
// A 1x1 PNG used as the object previews.
const png = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);
const object = (id, objectRel, type = 'Embed', progId = 'Excel.Sheet.12') =>
  `<w:r><w:object w:dxaOrig="6000" w:dyaOrig="1200"><v:shape id="_x0000_i${id}" style="width:300pt;height:60pt" o:ole=""><v:imagedata r:id="rIdPreview" o:title=""/></v:shape><o:OLEObject Type="${type}" ProgID="${progId}" ShapeID="_x0000_i${id}" DrawAspect="Content" ObjectID="_${id}" r:id="${objectRel}"/></w:object></w:r>`;

await save(
  'embedded-objects.docx',
  docx({
    namespaces: ` xmlns:v="${V}" xmlns:o="${O}"`,
    types:
      '<Default Extension="png" ContentType="image/png"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/><Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>',
    rels:
      `<Relationship Id="rIdPreview" Type="${R}/image" Target="media/preview.png"/>` +
      `<Relationship Id="rIdSheet" Type="${R}/package" Target="embeddings/Microsoft_Excel_Worksheet.xlsx"/>` +
      `<Relationship Id="rIdOle" Type="${R}/oleObject" Target="embeddings/oleObject1.bin"/>` +
      `<Relationship Id="rIdLinked" Type="${R}/oleObject" Target="file:///C:/Reports/linked.xlsx" TargetMode="External"/>`,
    body: [
      heading('Embedded objects'),
      p(run('The budget sheet follows.')),
      p(object(1025, 'rIdSheet')),
      p(run('A packaged document follows.')),
      p(object(1026, 'rIdOle', 'Embed', 'Word.Document.12')),
      p(run('A linked sheet is reported, never opened.')),
      p(object(1027, 'rIdLinked', 'Link')),
      p(run('The same sheet again is read once.')),
      p(object(1028, 'rIdSheet')),
    ].join(''),
    parts: {
      'word/media/preview.png': png,
      'word/embeddings/Microsoft_Excel_Worksheet.xlsx': workbook,
      'word/embeddings/oleObject1.bin': oleObject,
    },
  }),
  'DOC-12, NST-1',
  'an embedded XLSX package part, an OLE .bin whose Package stream holds a DOCX, an external linked object and a repeated object reference.',
);

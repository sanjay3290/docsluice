import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hostile DOCX packages: deep content controls, a document.xml bomb, prototype-named style ids.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const directory = new URL('../../hostile/docx/', import.meta.url);
await mkdir(directory, { recursive: true });

function docx(documentXml, extra = {}) {
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': documentXml,
    ...extra,
  };
  const entries = Object.create(null);
  for (const [name, content] of Object.entries(files)) {
    entries[name] = [typeof content === 'string' ? strToU8(content) : content, { mtime: new Date('1980-01-01T00:00:00Z') }];
  }
  return zipSync(entries, { level: 9 });
}

const body = (inner) => `<w:document xmlns:w="${W}"><w:body>${inner}</w:body></w:document>`;
const para = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

await writeFile(
  new URL('deep-sdt-10000.docx', directory),
  docx(body(`${'<w:sdt><w:sdtContent>'.repeat(10_000)}${para('deep')}${'</w:sdtContent></w:sdt>'.repeat(10_000)}${para('after')}`)),
);

// About 40 MB of repetitive paragraph XML in a small archive: the compression-ratio limit must stop it.
const repeated = para('bomb').repeat(1_500_000);
await writeFile(new URL('document-bomb.docx', directory), docx(body(repeated)));

await writeFile(
  new URL('proto-style-ids.docx', directory),
  docx(
    body(
      `<w:p><w:pPr><w:pStyle w:val="__proto__"/></w:pPr><w:r><w:t>proto</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="constructor"/></w:pPr><w:r><w:t>constructor</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="prototype"/></w:pPr><w:r><w:t>prototype</w:t></w:r></w:p>`,
    ),
    {
      'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="__proto__"><w:name w:val="heading 1"/><w:basedOn w:val="constructor"/></w:style><w:style w:type="paragraph" w:styleId="constructor"><w:basedOn w:val="__proto__"/></w:style><w:style w:type="paragraph" w:styleId="prototype"><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>`,
    },
  ),
);

// A level whose lvlText repeats %1 50,000 times on 500 items: markers alone exceed outputChars.
const flood = `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="${'%1'.repeat(50_000)}"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
const items = '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>'.repeat(500);
await writeFile(
  new URL('numbering-marker-flood.docx', directory),
  docx(body(items), {
    'word/numbering.xml': flood,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="n" Type="${R}/numbering" Target="numbering.xml"/></Relationships>`,
  }),
);

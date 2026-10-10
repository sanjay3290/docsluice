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

// 1,000 tables nested in cells: depth is flattened at blockDepth, then the XML depth budget stops the scan.
await writeFile(
  new URL('deep-tables-1000.docx', directory),
  docx(body(`${'<w:tbl><w:tr><w:tc>'.repeat(1_000)}${para('core')}${'</w:tc></w:tr></w:tbl>'.repeat(1_000)}`)),
);

// 3,000 rows of one cell spanning 1,000 grid columns: a few kilobytes that would expand to 3 million cells.
const wide = `<w:tbl>${'<w:tr><w:tc><w:tcPr><w:gridSpan w:val="1000"/></w:tcPr><w:p/></w:tc></w:tr>'.repeat(3_000)}</w:tbl>`;
await writeFile(new URL('gridspan-flood.docx', directory), docx(body(wide)));

// Notes with prototype-named ids, each referenced 5,000 times: every note must appear once.
const refs = '<w:r><w:footnoteReference w:id="__proto__"/></w:r><w:r><w:commentReference w:id="constructor"/></w:r>'.repeat(5_000);
await writeFile(
  new URL('notes-proto-ids.docx', directory),
  docx(body(`<w:p><w:r><w:t>anchor</w:t></w:r>${refs}</w:p>`), {
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:id="__proto__">${para('proto note')}</w:footnote></w:footnotes>`,
    'word/comments.xml': `<w:comments xmlns:w="${W}"><w:comment w:id="constructor" w:author="__proto__">${para('constructor comment')}</w:comment></w:comments>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="${PKG}"><Relationship Id="f" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="c" Type="${R}/comments" Target="comments.xml"/></Relationships>`,
  }),
);

// Odd picture markup and 100 nested revisions: prototype-named alt text, a 30-digit extent, a missing
// relationship, a non-finite VML size.
const nestedRevisions = `${'<w:ins w:id="1"><w:del w:id="2">'.repeat(50)}<w:r><w:t>nested</w:t></w:r>${'</w:del></w:ins>'.repeat(50)}`;
await writeFile(
  new URL('image-and-revision-oddities.docx', directory),
  docx(
    body(
      `<w:p>${nestedRevisions}<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="${'9'.repeat(30)}" cy="-5"/><wp:docPr id="1" name="x" descr="__proto__"/><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" r:embed="missing"/></wp:inline></w:drawing></w:r>` +
        `<w:r><w:pict><v:shape xmlns:v="urn:schemas-microsoft-com:vml" style="width:1e309pt;height:-5in;width:3pt" alt="constructor"/></w:pict></w:r></w:p>`,
    ),
  ),
);

import { writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { strToU8, zipSync } from 'fflate';

// Hand-made tracked changes and images (CC0-1.0), written from ECMA-376 Part 1, 17.13 and 20.4.
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const V = 'urn:schemas-microsoft-com:vml';
const O = 'urn:schemas-microsoft-com:office:office';

const run = (text) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const del = (text, id) =>
  `<w:del w:id="${id}" w:author="Reviewer" w:date="2026-05-14T10:00:00Z"><w:r><w:delText xml:space="preserve">${text}</w:delText></w:r></w:del>`;
const ins = (text, id) => `<w:ins w:id="${id}" w:author="Reviewer" w:date="2026-05-14T10:00:00Z">${run(text)}</w:ins>`;
const p = (inner, props = '') => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${inner}</w:p>`;
const markDeleted = '<w:rPr><w:del w:id="20" w:author="Reviewer" w:date="2026-05-14T10:00:00Z"/></w:rPr>';
const markInserted = '<w:rPr><w:ins w:id="21" w:author="Reviewer" w:date="2026-05-14T10:00:00Z"/></w:rPr>';
const drawing = (id, descr, title, cx, cy, blip) =>
  `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${id}" name="Picture ${id}" descr="${descr}" title="${title}"/><a:graphic><a:graphicData uri="${PIC}"><pic:pic><pic:blipFill><a:blip ${blip}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const body = [
  p(run('Tracked changes and images'), '<w:pStyle w:val="Heading1"/>'),
  p(run('The valve was ') + ins('replaced', 1) + del('repaired', 2) + run(' yesterday.')),
  p(
    `<w:moveFrom w:id="3" w:author="Reviewer" w:date="2026-05-14T10:00:00Z"><w:r><w:t>Moved sentence.</w:t></w:r></w:moveFrom>` +
      run(' Remaining text.'),
  ),
  p(run('First half'), markDeleted),
  p(run(' joins the second half when the mark deletion is accepted.')),
  p(run('An inserted break'), markInserted),
  p(run(' disappears when insertions are rejected.')),
  p(run('Destination: ') + `<w:moveTo w:id="4" w:author="Reviewer" w:date="2026-05-14T10:00:00Z"><w:r><w:t>Moved sentence.</w:t></w:r></w:moveTo>`),
  p(run('Figure below.') + drawing(1, 'Marsh map', 'Map of the marsh', 1905000, 952500, `r:embed="rIdImage1"`)),
  p(
    `<w:r><w:pict><v:shape id="legacy" alt="Legacy figure" o:title="Old title" style="width:96pt;height:48pt"><v:imagedata r:id="rIdImage2" o:title="Old title"/></v:shape></w:pict></w:r>`,
  ),
  p(drawing(3, 'Remote picture', '', 952500, 952500, `r:link="rIdRemote"`)),
  p(run('Closing paragraph.')),
].join('');

// A 1x1 transparent PNG (signature, IHDR, IDAT, IEND).
const png = new Uint8Array(
  Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'),
);

const files = {
  '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PKG}"><Relationship Id="rIdImage1" Type="${R}/image" Target="media/image1.png"/><Relationship Id="rIdImage2" Type="${R}/image" Target="media/image2.png"/><Relationship Id="rIdRemote" Type="${R}/image" Target="https://example.invalid/remote.png" TargetMode="External"/></Relationships>`,
  'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="${WP}" xmlns:a="${A}" xmlns:pic="${PIC}" xmlns:v="${V}" xmlns:o="${O}"><w:body>${body}</w:body></w:document>`,
};
const entries = Object.create(null);
for (const [name, text] of Object.entries(files)) entries[name] = [strToU8(text), { mtime: new Date('1980-01-01T00:00:00Z') }];
entries['word/media/image1.png'] = [png, { mtime: new Date('1980-01-01T00:00:00Z') }];
entries['word/media/image2.png'] = [png, { mtime: new Date('1980-01-01T00:00:00Z') }];
await writeFile(new URL('../../corpus/docx/revisions-images.docx', import.meta.url), zipSync(entries, { level: 9 }));
await writeFile(
  new URL('../../corpus/docx/revisions-images.docx.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-docx-revisions.mjs\nRequirements: DOC-6, DOC-8\nNotes: insertions, deletions, a move, deleted and inserted paragraph marks; an inline drawing with alt text and extent, a VML picture, and an external linked image.\n',
);

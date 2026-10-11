import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { TextDecoder, TextEncoder } from 'node:util';
import { HELVETICA, pdf, stream, textPage } from '../corpus/pdf-writer.mjs';

// Damaged PDFs (PDF-9): each must give the pages that can be read and UNREADABLE_PART warnings for
// the rest, without hanging or crashing. All start from one five-page text PDF.
const directory = new URL('../../hostile/pdf/', import.meta.url);
await mkdir(directory, { recursive: true });
const encoder = new TextEncoder();
const PAGES = 5;

/** Objects: 1 catalog, 2 pages, 3 font, 4.. pages, then their content streams. */
function objects(contents = (index) => stream(textPage([`Page ${index + 1} text survives.`]))) {
  const pages = Array.from({ length: PAGES }, (_, index) => 4 + index);
  return [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((page) => `${page} 0 R`).join(' ')}] /Count ${PAGES} >>`,
    HELVETICA,
    ...pages.map(
      (_, index) =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${4 + PAGES + index} 0 R >>`,
    ),
    ...pages.map((_, index) => contents(index)),
  ];
}
const whole = pdf(objects(), '/Root 1 0 R');
const text = new TextDecoder('latin1').decode(whole);

// Cut off after page 3's content stream: pages 4 and 5, the xref table and the trailer are gone.
const cut = text.indexOf('endobj', text.indexOf(`${4 + PAGES + 2} 0 obj`)) + 'endobj'.length;
await writeFile(new URL('damaged-truncated.pdf', directory), whole.slice(0, cut));

// Every xref offset points 7 bytes too far: the engine must rebuild the cross-reference table.
await writeFile(
  new URL('damaged-xref-offsets.pdf', directory),
  encoder.encode(text.replace(/^(\d{10}) 00000 n $/gmu, (_, offset) => `${String(Number(offset) + 7).padStart(10, '0')} 00000 n `)),
);

// Page 2's content stream claims Flate compression but holds garbage.
await writeFile(
  new URL('damaged-page-content.pdf', directory),
  pdf(
    objects((index) =>
      index === 1 ? stream('this is not deflate data at all', '/Filter /FlateDecode') : stream(textPage([`Page ${index + 1} text survives.`])),
    ),
    '/Root 1 0 R',
  ),
);

// One page dictionary cannot be parsed. Breaking the last page loses only that page. Breaking a
// middle page loses the pages after it too: the engine stops walking the page tree at the first
// kid it cannot read (#266).
const brokenPage = (page) => {
  const object = `${3 + page} 0 obj\n<< /Type /Page`;
  return encoder.encode(text.replace(object, `${object} ) ] >>`));
};
await writeFile(new URL('damaged-last-page-object.pdf', directory), brokenPage(5));
await writeFile(new URL('damaged-middle-page-object.pdf', directory), brokenPage(2));

// Page 2's dictionary is packed in an object stream (PDF 1.5) whose offsets table is garbage; page 1
// is an ordinary object. The xref stream is valid, so only page 2 is lost.
{
  const parts = [];
  let length = 0;
  const offsets = new Map();
  const push = (bytes) => {
    parts.push(bytes);
    length += bytes.length;
  };
  const add = (number, body) => {
    offsets.set(number, length);
    push(encoder.encode(`${number} 0 obj\n${body}\nendobj\n`));
  };
  push(encoder.encode('%PDF-1.5\n'));
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, '<< /Type /Pages /Kids [4 0 R 5 0 R] /Count 2 >>');
  add(3, HELVETICA);
  add(4, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 8 0 R >>');
  // Object stream 6 holds page 5; its offsets table ("x y") is not numbers.
  add(6, stream('x y << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>', '/Type /ObjStm /N 1 /First 4'));
  add(8, stream(textPage(['Page 1 text survives.'])));
  // Xref stream 7 with field widths [1 4 2] for objects 0-8.
  const entry = (type, field2, field3) => [
    type,
    field2 >>> 24,
    (field2 >>> 16) & 255,
    (field2 >>> 8) & 255,
    field2 & 255,
    field3 >> 8,
    field3 & 255,
  ];
  const xrefOffset = length;
  const rows = Uint8Array.from(
    [
      entry(0, 0, 65535),
      entry(1, offsets.get(1), 0),
      entry(1, offsets.get(2), 0),
      entry(1, offsets.get(3), 0),
      entry(1, offsets.get(4), 0),
      entry(2, 6, 0),
      entry(1, offsets.get(6), 0),
      entry(1, xrefOffset, 0),
      entry(1, offsets.get(8), 0),
    ].flat(),
  );
  push(encoder.encode(`7 0 obj\n<< /Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Length ${rows.length} >>\nstream\n`));
  push(rows);
  push(encoder.encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  const file = new Uint8Array(length);
  let position = 0;
  for (const part of parts) {
    file.set(part, position);
    position += part.length;
  }
  await writeFile(new URL('damaged-object-stream.pdf', directory), file);
}

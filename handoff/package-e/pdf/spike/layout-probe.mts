import { readFile } from 'node:fs/promises';
import { getDocumentProxy } from '/tmp/docsluice-pdf-spike/node_modules/unpdf/dist/index.mjs';
import { Budget } from '/workspace/docsluice-package-e-46/packages/docsluice/src/core/budget.js';
import { DEFAULT_LIMITS } from '/workspace/docsluice-package-e-46/packages/docsluice/src/core/limits.js';
import { layoutPage, type TextItem } from '/workspace/docsluice-package-e-46/packages/docsluice/src/readers/pdf/layout/layout.js';

const fixture = process.argv[2] ?? '/workspace/package-e-preparation/pdf-fixtures/layout/generated/layout-reference-10-pages.pdf';
const bytes = new Uint8Array(await readFile(fixture));
const pdf = await getDocumentProxy(bytes, {
  isEvalSupported: false,
  useWorkerFetch: false,
  useWasm: false,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
});
const pages = [];
for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
  const page = await pdf.getPage(pageNumber);
  const raw = await page.getTextContent();
  const items: TextItem[] = [];
  let sourceIndex = 0;
  for (const candidate of raw.items) {
    if (!('str' in candidate)) continue;
    const transform = candidate.transform as [number, number, number, number, number, number];
    items.push({
      text: candidate.str,
      transform,
      width: candidate.width,
      height: candidate.height,
      fontSize: Math.hypot(transform[0], transform[1]),
      dir: candidate.dir as 'ltr' | 'rtl',
      sourceIndex: sourceIndex++,
    });
  }
  const budget = new Budget(DEFAULT_LIMITS);
  const result = layoutPage(
    items,
    { width: page.view[2] - page.view[0], height: page.view[3] - page.view[1], rotation: page.rotate as 0 | 90 | 180 | 270 },
    budget,
  );
  pages.push({
    pageNumber,
    page: result.page,
    rawItemCount: items.length,
    unsupportedDirectionItems: result.unsupportedDirectionItems,
    lines: result.lines.map(({ text, x, y, width, height, fontSize, dir, sourceIndices, column }) => ({
      text, x, y, width, height, fontSize, dir, sourceIndices, column,
    })),
    paragraphs: result.paragraphs.map(({ text, heading }) => ({ text, heading })),
  });
  await page.cleanup();
}
await pdf.destroy();
process.stdout.write(`${JSON.stringify({ fixture, pages }, null, 2)}\n`);

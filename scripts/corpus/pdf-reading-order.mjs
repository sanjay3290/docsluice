// PDF reading-order accuracy (PDF-2, the start of QA-7): word order on ten hand-checked corpus pages.
// The references were checked by hand against each page's layout. Run after `npm run build`:
// node scripts/corpus/pdf-reading-order.mjs
import { extract } from '../../packages/docsluice/dist/index.js';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
const F = 'The survey team walked the line at low tide, noting the plants, the soil and the water in each plot before the tide returned to cover the flats again.';
const seq = (p, from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${p}${from + i}. ${F}`).join(' ');
const pages = [
  ['article-two-columns', 1, `Salt Marsh Survey Report A synthetic two-column article for reading-order tests Paragraph A1. The marsh covers 12 km2 of tidal flats and channels1, and the survey began at the northern dike. ${F} Paragraph A1b. ${F} ${seq('Paragraph A', 2, 7)} Findings by Zone ${seq('Paragraph B', 1, 6)} 1 Footnote one: tide tables came from a synthetic almanac made for this fixture.`],
  ['article-two-columns', 2, `Methods ${seq('Paragraph C', 1, 14)}`],
  ['newsletter-three-columns', 1, `Harbour Newsletter Three columns of synthetic notes for reading-order tests ${seq('Note N', 1, 9)}`],
  ['lists-tables', 1, 'Seed Bank Inventory Seed Bank Inventory  Coastal grasses  Salt meadow cordgrass  Spike grass  Flowering plants  Sea lavender North beds (merged heading) Zone Bed N1 plus N3 (vertical merge) Bed N2 High marsh Inner plot (nested table) Bed N4 Low marsh'],
  ['notes-comments-revisions', 1, 'Maintenance Record Maintenance Record Valve inspection completed on 2026-05-14. Valve pressure rose to 18 kPaReplacement gasket fitted.. Inspect the eastern line. Safety review1 Archive referencei 1 Pressure was measured with a synthetic test gauge.'],
  ['hyperlinks-image', 1, 'Marsh Transect Diagram Marsh Transect Diagram Open the transect protocol for method details. Image follows the site description.'],
  ['labels-outline-links', 1, 'Preface This survey was made for parser testing.'],
  ['headings-outline', 2, 'Field Notes Header — Synthetic CC0 A synthetic observation log for parser testing. Field Notes Footer — Page 2'],
  ['headings-outline', 6, 'Field Notes Header — Synthetic CC0 This heading uses a custom style name and an explicit outline level. Field Notes Footer — Page 6'],
  ['deck-slide-order', 1, 'slide1 Slide 01 Order marker 01'],
];
const lcs = (a, b) => { let prev = new Array(b.length + 1).fill(0); for (const x of a) { const cur = [0]; for (let j = 0; j < b.length; j++) cur.push(x === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j])); prev = cur; } return prev[b.length]; };
const words = (s) => s.split(/\s+/u).filter(Boolean);
const textOf = (block) => [block.text ?? '', ...(block.blocks ?? []).map(textOf)].join(' ');
let total = 0, hit = 0, exact = 0;
for (const [file, page, ref] of pages) {
  const doc = await extract(new Uint8Array(readFileSync(new URL(`../../corpus/pdf/${file}.pdf`, import.meta.url))));
  const section = doc.blocks.find((b) => b.loc?.page === page);
  const out = words(textOf(section)); const want = words(ref);
  const score = lcs(want, out); total += want.length; hit += score; if (score === want.length && out.length === want.length) exact++;
  console.log(`${file} p${page}: ${score}/${want.length} words in order (output ${out.length})`);
}
console.log(`word-order accuracy ${(100 * hit / total).toFixed(1)}% (${hit}/${total}); pages exact: ${exact}/10`);

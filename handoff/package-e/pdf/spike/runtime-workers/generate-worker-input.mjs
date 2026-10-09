import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const prepRoot = path.resolve(here, '../../..');
const fixtureRoot = path.join(prepRoot, 'pdf-fixtures', 'generated');
const outputDir = process.argv[2] ?? '/tmp/docsluice-workerd-tools/src';
const inputs = {
  'labels-outline-links.pdf': path.join(fixtureRoot, 'labels-outline-links.pdf'),
  'two-columns.pdf': path.join(fixtureRoot, 'two-columns.pdf'),
  'image-only.pdf': path.join(fixtureRoot, 'image-only.pdf'),
  'hostile-actions.pdf': path.join(fixtureRoot, 'hostile', 'actions.pdf'),
  'text-100-pages.pdf': path.join(fixtureRoot, 'text-100-pages.pdf'),
};

const embedded = {};
for (const [name, filename] of Object.entries(inputs)) {
  embedded[name] = (await readFile(filename)).toString('base64');
}
await mkdir(outputDir, { recursive: true });
const template = await readFile(path.join(here, 'worker-template.mjs'), 'utf8');
const entry = template.replace('__EMBEDDED_FIXTURES__', JSON.stringify(embedded));
if (entry === template) throw new Error('Worker fixture placeholder not substituted.');
await writeFile(path.join(outputDir, 'worker-entry.mjs'), entry, 'utf8');
console.log(JSON.stringify({ output: path.join(outputDir, 'worker-entry.mjs'), fixtures: Object.keys(inputs) }));

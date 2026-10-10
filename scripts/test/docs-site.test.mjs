import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { URL } from 'node:url';
import { DEFAULT_LIMITS } from '../../packages/docsluice/src/core/limits.ts';
import { buildSite, slug } from '../docs-site.mjs';

const out = mkdtempSync(join(tmpdir(), 'docsluice-site-'));
after(() => rmSync(out, { recursive: true, force: true }));
// The API reference (TypeDoc) is built by `npm run docs:site`; these checks need only the pages.
const built = buildSite({ out, api: false });
const page = (path) => readFileSync(join(out, path), 'utf8');

test('every page builds and every internal link and anchor resolves', async () => {
  const { pages, broken } = await built;
  assert.deepEqual(broken, []);
  for (const required of [
    'index.html',
    'quickstart.html',
    'security.html',
    'limits.html',
    'recipes/index.html',
  ])
    assert.ok(pages.includes(required), required);
  const formats = readdirSync(new URL('../../docs/formats/', import.meta.url)).filter((name) =>
    name.endsWith('.md'),
  );
  for (const name of formats) assert.ok(pages.includes(`formats/${name.slice(0, -3)}.html`), name);
});

test('the limits table lists every default limit with its value and description', async () => {
  await built;
  const html = page('limits.html');
  for (const [name, value] of Object.entries(DEFAULT_LIMITS)) {
    assert.match(
      html,
      new RegExp(`<td><code>${name}</code></td>\\s*<td>${value.toLocaleString('en-US')}</td>`),
      name,
    );
  }
  assert.match(html, /Always throws\./);
});

test('recipe pages show the tested example files', async () => {
  await built;
  for (const name of ['rag', 'upload', 'redaction', 'ocr']) {
    const source = readFileSync(new URL(`../../examples/${name}.mjs`, import.meta.url), 'utf8');
    const firstExport = source.match(/export (?:async )?function (\w+)/)[1];
    assert.ok(page(`recipes/${name}.html`).includes(firstExport), name);
  }
});

test('links become site links: .md to .html, outside docs to the repository', async () => {
  await built;
  assert.ok(page('index.html').includes('href="quickstart.html"'));
  assert.ok(page('recipes/upload.html').includes('href="../worker.html"'));
  assert.ok(page('prd.html').includes('href="adr/README.html"'));
  assert.ok(page('index.html').includes('<nav>'));
});

test('heading ids follow GitHub', () => {
  assert.equal(slug('Header rows (XLS-8)'), 'header-rows-xls-8');
  assert.equal(
    slug('Comments, Excel tables and defined names (XLS-9)'),
    'comments-excel-tables-and-defined-names-xls-9',
  );
  assert.equal(slug('Main content (HTM-2)'), 'main-content-htm-2');
});

// Runs the BUILT package with node:test on every supported Node version (Node 20+).
// Vitest needs Node 22+, so this file proves the published output works on Node 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderDoc = {
  format: 'txt',
  mimeType: 'text/plain',
  metadata: {},
  features: {
    hasMacros: false,
    hasExternalLinks: false,
    hasEmbeddedFiles: false,
    isEncrypted: false,
    hasJavaScript: false,
  },
  blocks: [
    { kind: 'heading', level: 1, text: 'Title', loc: {} },
    { kind: 'table', rows: [[{ text: 'a' }, { text: 'b' }]], headerRows: 1, loc: {} },
  ],
  children: [],
  warnings: [],
  stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
};

test('ESM entry loads', async () => {
  const mod = await import('../dist/index.js');
  assert.equal(typeof mod.resolveLimits, 'function');
  assert.equal(mod.DEFAULT_LIMITS.zipEntries, 10_000);
  assert.equal(typeof mod.parseXml, 'function');
  assert.equal(typeof mod.scanXml, 'function');
  const image = await mod.extract(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
  assert.equal(image.format, 'png');
  assert.deepEqual(image.blocks, []);
  assert.equal(mod.toText(renderDoc), 'Title\n\na\tb');
  assert.equal(typeof mod.toJSON, 'function');
  assert.equal(
    (await mod.detect(Uint8Array.of(123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125))).format,
    'json',
  );
  const warnings = new mod.WarningSink();
  const budget = new mod.Budget(mod.DEFAULT_LIMITS, { warnings });
  const tree = mod.parseXml('<root>text</root>', { budget, warnings });
  assert.equal(tree?.children[0], 'text');
});

test('CJS entry loads', () => {
  const mod = require('../dist/index.cjs');
  assert.equal(typeof mod.resolveLimits, 'function');
  assert.equal(mod.toText(renderDoc), 'Title\n\na\tb');
  assert.equal(typeof mod.toJSON, 'function');
});

test('node entry loads', async () => {
  const mod = await import('../dist/node/index.js');
  assert.equal(typeof mod.DocsluiceError, 'function');
});

test('DOC reader subpath loads lazily', async () => {
  const mod = await import('docsluice/doc');
  assert.equal(mod.docReader.id, 'doc');
  assert.equal(typeof mod.docReader.read, 'function');
});

test('TXT and Markdown reader subpaths load lazily', async () => {
  const txt = await import('docsluice/txt');
  assert.equal(txt.txtReader.id, 'txt');
  const markdown = await import('docsluice/markdown');
  assert.equal(markdown.markdownReader.id, 'markdown');
});

test('CSV and TSV reader subpaths load lazily', async () => {
  const csv = await import('docsluice/csv');
  assert.equal(csv.csvReader.id, 'csv');
  const tsv = await import('docsluice/tsv');
  assert.equal(tsv.tsvReader.id, 'tsv');
});

test('JSON and XML reader subpaths load lazily', async () => {
  const json = await import('docsluice/json');
  assert.equal(json.jsonReader.id, 'json');
  const xml = await import('docsluice/xml');
  assert.equal(xml.xmlReader.id, 'xml');
});

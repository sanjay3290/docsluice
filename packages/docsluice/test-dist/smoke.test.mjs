// Runs the BUILT package with node:test on every supported Node version (Node 20+).
// Vitest needs Node 22+, so this file proves the published output works on Node 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

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
  const image = await mod.extract(
    new Uint8Array(readFileSync(new URL('../../../corpus/images/tiny.png', import.meta.url))),
  );
  assert.equal(image.format, 'png');
  assert.deepEqual(image.blocks, [
    { kind: 'image', mimeType: 'image/png', width: 1, height: 1, loc: { offset: [0, 0] } },
  ]);
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

test('JSON Schema package export loads', () => {
  const packageVersion = require('../package.json').version;
  const schema = require('docsluice/schema.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(schema.$id, `https://github.com/sanjay3290/docsluice/schema/v${packageVersion.split('.')[0]}`);
  assert.equal(schema.$ref, '#/$defs/DocsluiceDocument');
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

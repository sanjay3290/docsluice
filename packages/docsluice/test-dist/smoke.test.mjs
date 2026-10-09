// Runs the BUILT package with node:test on every supported Node version (Node 20+).
// Vitest needs Node 22+, so this file proves the published output works on Node 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('ESM entry loads', async () => {
  const mod = await import('../dist/index.js');
  assert.equal(typeof mod.resolveLimits, 'function');
  assert.equal(mod.DEFAULT_LIMITS.zipEntries, 10_000);
  assert.equal(typeof mod.parseXml, 'function');
  assert.equal(typeof mod.scanXml, 'function');
  const warnings = new mod.WarningSink();
  const budget = new mod.Budget(mod.DEFAULT_LIMITS, { warnings });
  const tree = mod.parseXml('<root>text</root>', { budget, warnings });
  assert.equal(tree?.children[0], 'text');
});

test('CJS entry loads', () => {
  const mod = require('../dist/index.cjs');
  assert.equal(typeof mod.resolveLimits, 'function');
});

test('node entry loads', async () => {
  const mod = await import('../dist/node/index.js');
  assert.equal(typeof mod.DocsluiceError, 'function');
});

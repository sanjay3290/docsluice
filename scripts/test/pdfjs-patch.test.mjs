import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { patchPdfJs } from '../pdfjs-patch.mjs';

const site =
  'this.toplevelPagesDict&&kid instanceof Ref&&!cache.has(kid)&&cache.put(kid,xref.fetchAsync(kid))';

test('the prefetch patch retains the promise and its rejection for later callers', async () => {
  const source = `export function prefetch(kid, Ref, cache, xref) { return ${site}; }`;
  const patched = await import(`data:text/javascript,${encodeURIComponent(patchPdfJs(source))}`);
  const failure = new Error('malformed page kid');
  const promise = Promise.reject(failure);
  let handlers = 0;
  const originalCatch = promise.catch.bind(promise);
  promise.catch = (...args) => {
    handlers += 1;
    return originalCatch(...args);
  };
  class Ref {}
  const kid = new Ref();
  let stored;
  const cache = {
    has: () => false,
    put: (key, value) => {
      assert.equal(key, kid);
      stored = value;
    },
  };
  patched.prefetch.call({ toplevelPagesDict: true }, kid, Ref, cache, { fetchAsync: () => promise });
  await assert.rejects(stored, failure);
  assert.equal(stored, promise);
  assert.equal(handlers, 1);
});

test('the prefetch patch refuses a missing, changed, or repeated site', () => {
  for (const source of ['', site.replace('fetchAsync(kid)', 'fetchAsync(other)'), `${site};${site}`])
    assert.throws(() => patchPdfJs(source), /exactly once/);
});

test('the pinned engine has exactly one patch site', async () => {
  const source = await readFile(import.meta.resolve('unpdf/pdfjs').replace('file://', ''), 'utf8');
  assert.ok(patchPdfJs(source) !== source);
  assert.throws(() => patchPdfJs(patchPdfJs(source)), /exactly once/);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { patchPdfJs } from '../pdfjs-patch.mjs';

const site =
  'this.toplevelPagesDict&&kid instanceof Ref&&!cache.has(kid)&&cache.put(kid,xref.fetchAsync(kid))';
const indexSite =
  '.push(xref.fetchAsync(kid).then(node=>{if(!(node instanceof Node))throw new Failure(`Kid node must be a dictionary.`);if(node.has(`Count`)){let amount=node.get(`Count`);if(Number.isInteger(amount)&&amount>=0){count+=amount;return}throw new Failure(`Count must be a (positive) integer.`)}count++}))';
const prefetchSource = `export function prefetch(kid, Ref, cache, xref) { return ${site}; }`;
const indexSource = `export function prefetchIndex(xref, kid, Node, Failure) { let count = 0; const pending = []; pending${indexSite}; return pending[0]; }`;

test('the prefetch patch retains the promise and its rejection for later callers', async () => {
  const source = `${prefetchSource};${indexSource}`;
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

test('the page-index patch retains the callback promise and its rejection', async () => {
  const source = `${prefetchSource};${indexSource}`;
  const patched = await import(`data:text/javascript,${encodeURIComponent(patchPdfJs(source))}`);
  const promise = Promise.resolve(42);
  const originalThen = promise.then.bind(promise);
  let callbackPromise;
  let handlers = 0;
  promise.then = (...args) => {
    callbackPromise = originalThen(...args);
    const originalCatch = callbackPromise.catch.bind(callbackPromise);
    callbackPromise.catch = (...args) => {
      handlers += 1;
      return originalCatch(...args);
    };
    return callbackPromise;
  };
  class Node {}
  const stored = patched.prefetchIndex({ fetchAsync: () => promise }, {}, Node, Error);
  assert.equal(stored, callbackPromise);
  assert.equal(handlers, 1);
  await assert.rejects(stored, /Kid node must be a dictionary/);
});

test('the prefetch patch refuses a missing, changed, or repeated site', () => {
  for (const source of ['', site.replace('fetchAsync(kid)', 'fetchAsync(other)'), `${site};${site}`])
    assert.throws(() => patchPdfJs(`${source};pending${indexSite}`), /exactly once/);
});

test('the page-index patch refuses a missing, changed, or repeated site', () => {
  for (const source of [
    '',
    indexSite.replace('node instanceof Node', 'other instanceof Node'),
    `${indexSite};pending${indexSite}`,
  ])
    assert.throws(() => patchPdfJs(`${site};pending${source}`), /exactly once/);
});

test('the pinned engine has exactly one match for each patch site', async () => {
  const source = await readFile(fileURLToPath(import.meta.resolve('unpdf/pdfjs')), 'utf8');
  assert.ok(patchPdfJs(source) !== source);
  assert.throws(() => patchPdfJs(patchPdfJs(source)), /exactly once/);
});

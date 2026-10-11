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
const rangeSite = (method) =>
  `${method}(low,high,value){if(high-low>MAX)throw Error(\`${method} - ignoring data above MAX_MAP_RANGE.\`);for(;low<=high;)this.map.set(low++,value)}`;
const oneSite = 'mapOne(code,value){this._map[code]=value}';
const cmapSource = `const MAX = 2 ** 24 - 1; export class CMap { map = new Map(); _map = []; ${['mapCidRange', 'mapBfRange', 'mapBfRangeToArray'].map(rangeSite).join(' ')} ${oneSite} }`;
const fontSite =
  'loadFont(name,dict,extra=null){let errorFont=async()=>`error`;if(dict.cacheKey&&this.fontCache.has(dict.cacheKey))return this.fontCache.get(dict.cacheKey);let{promise:done}=Promise.withResolvers();return `loaded`}';
const fontSource = `export class Evaluator { fontCache = new Map(); idFactory = { getDocId: () => 'g_d7' }; ${fontSite} }`;
/** A synthetic engine with every patch site once; `replace` swaps one site's text. */
const engine = (replace = (text) => text) =>
  [prefetchSource, indexSource, cmapSource, fontSource].map(replace).join(';\n');
const load = (source) => import(`data:text/javascript,${encodeURIComponent(patchPdfJs(source))}`);

test('the prefetch patch retains the promise and its rejection for later callers', async () => {
  const patched = await load(engine());
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
  const patched = await load(engine());
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

test('each CMap maps at most 65,536 codes through ranges', async () => {
  const { CMap } = await load(engine());
  const cmap = new CMap();
  cmap.mapBfRange(0, 0xfeff, 'A');
  cmap.mapCidRange(0xff00, 0xffff, 1);
  assert.equal(cmap.map.size, 65_536);
  // Past the cap, every range method takes pdf.js's existing error path: parseCMap catches the
  // error, warns and keeps parsing, so the range is dropped and the document keeps reading.
  for (const method of ['mapCidRange', 'mapBfRange', 'mapBfRangeToArray'])
    assert.throws(() => cmap[method](0, 0, 1), new RegExp(`${method} - ignoring data`));
  assert.equal(cmap.map.size, 65_536);
  // The cap is per CMap, and one oversized range is refused before its loop runs.
  const other = new CMap();
  assert.throws(() => other.mapBfRange(0, 0xff_fffe, 'A'), /ignoring data above MAX_MAP_RANGE/);
  assert.equal(other.map.size, 0);
  other.mapBfRange(5, 4, 'A');
  other.mapBfRange(0, 65_535, 'A');
  assert.equal(other.map.size, 65_536);
});

test('each CMap stores only codes below 65,536', async () => {
  const { CMap } = await load(engine());
  const cmap = new CMap();
  // One high code would make pdf.js copy the CMap into an array of 16.7 million slots.
  assert.throws(() => cmap.mapBfRange(0xff_ff00, 0xff_ffff, 'A'), /ignoring data/);
  assert.throws(() => cmap.mapCidRange(0xff00, 0x1_0000, 1), /ignoring data/);
  cmap.mapOne(0xff_ffff, 'A');
  cmap.mapOne(0xffff, 'B');
  assert.deepEqual(Object.keys(cmap._map), ['65535']);
  assert.equal(cmap.map.size, 0);
});

test('the engine refuses fonts past the tracked allowance', async () => {
  const { Evaluator, docsluiceTrackPdfFonts } = await load(engine());
  const evaluator = new Evaluator();
  assert.equal(await evaluator.loadFont('F0', {}), 'loaded');
  const fonts = docsluiceTrackPdfFonts('d7', 2);
  assert.equal(await evaluator.loadFont('F1', {}), 'loaded');
  assert.equal(await evaluator.loadFont('F2', {}), 'loaded');
  assert.equal(fonts.denied, false);
  assert.equal(await evaluator.loadFont('F3', {}), 'error');
  assert.deepEqual([fonts.loaded, fonts.denied], [2, true]);
  // A cached font is not a new load.
  evaluator.fontCache.set('key', 'cached');
  assert.equal(await evaluator.loadFont('F4', { cacheKey: 'key' }), 'cached');
  fonts.release();
  assert.equal(await evaluator.loadFont('F5', {}), 'loaded');
});

test('every patch refuses a missing, changed, or repeated site', () => {
  const sites = [
    [site, site.replace('fetchAsync(kid)', 'fetchAsync(other)')],
    [indexSite, indexSite.replace('node instanceof Node', 'other instanceof Node')],
    ...['mapCidRange', 'mapBfRange', 'mapBfRangeToArray'].map((method) => [
      rangeSite(method),
      rangeSite(method).replace('high-low>MAX', 'low-high>MAX'),
    ]),
    [oneSite, oneSite.replace('_map[code]=value', '_map[value]=code')],
    [fontSite, fontSite.replace('let errorFont', 'let otherFont')],
  ];
  assert.ok(patchPdfJs(engine()));
  for (const [text, changed] of sites)
    for (const variant of ['', changed, `${text} ${text}`])
      assert.throws(
        () => patchPdfJs(engine((part) => part.replace(text, variant))),
        /exactly once/,
        text.slice(0, 40),
      );
});

test('the pinned engine has exactly one match for each patch site', async () => {
  const source = await readFile(fileURLToPath(import.meta.resolve('unpdf/pdfjs')), 'utf8');
  assert.ok(patchPdfJs(source) !== source);
  assert.throws(() => patchPdfJs(patchPdfJs(source)), /exactly once/);
});

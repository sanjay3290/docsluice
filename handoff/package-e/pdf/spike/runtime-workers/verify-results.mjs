import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const filename = process.argv[2] ?? new URL('./workerd-result.json', import.meta.url);
const result = JSON.parse(await readFile(filename, 'utf8'));
assert.equal(result.status, 'LOCAL_WORKER_RUNTIME_PROBE_ONLY_NOT_ACCEPTANCE');
assert.equal(result.compatibilityDate, '2026-08-03');
assert.equal(result.nodejsCompatEnabled, false);
assert.equal(result.globalOutbound, 'deny-outbound');
assert.equal(result.globalOutboundPolicy, 'network service with empty allow and deny lists; no network destination is allowed');
assert.equal(result.bufferGlobalAvailable, false);
assert.equal(result.candidate, 'unpdf@1.7.0 research candidate');
assert.equal(result.pdfjsVersion, '5.6.205');
for (const installed of Object.values(result.instrumentationInstalled)) assert.equal(installed, true);
assert.deepEqual(result.patchErrors, []);
assert.deepEqual(result.attempts, {
  fetch: 0,
  xhr: 0,
  worker: 0,
  eval: 0,
  functionApply: 0,
  functionConstruct: 0,
});
assert.deepEqual(result.globalMarkerBeforeAndAfter, [0, 0]);

const [labels, columns, image, actions] = result.fixtureResults;
assert.equal(labels.name, 'labels-outline-links.pdf');
assert.equal(labels.pages, 3);
assert.deepEqual(labels.labels, ['i', 'ii', 'A-3']);
assert.deepEqual(labels.outlineTitles, ['Synthetic bookmark']);
assert.equal(labels.metadataEnabled.title, 'Original docsluice synthetic fixture');
assert.deepEqual(labels.metadataEnabled.authors, ['Synthetic author']);
assert.deepEqual(labels.metadataDisabled, {});
assert.deepEqual(labels.firstPageItems[0], {
  str: 'Synthetic first page',
  x: 48,
  y: 740,
  width: 102.04799999999997,
  height: 12,
  dir: 'ltr',
  hasEOL: true,
});
assert.deepEqual(labels.firstPageAnnotations, [{
  subtype: 'Link',
  url: 'https://example.invalid/docsluice',
  unsafeUrl: 'https://example.invalid/docsluice',
}]);
assert.deepEqual(columns.pageText, ['Full width titleLeft first Right firstLeft second Right second']);
assert.deepEqual(columns.firstPageItems.map(({ str }) => str).filter(Boolean).slice(0, 2), [
  'Full width title',
  'Left first',
]);
assert.equal(image.itemCount, 0);
assert.equal(image.textChars, 0);
assert.deepEqual(image.pageText, ['']);
assert.deepEqual(actions.jsActions, { OpenAction: ['this.docsluiceMarker = 1;'] });
assert.equal(result.hundredPage.pages, 100);
assert.equal(result.hundredPage.itemCount, 100);
assert.equal(result.hundredPage.textChars, 3000);
assert.equal(result.hundredPage.lastPageText, 'Synthetic performance page 100');

console.log(JSON.stringify({ status: 'expected-source-facts-match', fixtures: 5, counterGuards: result.attempts }));

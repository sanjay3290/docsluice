// Tests for the docs-site recipes (ADR 0013). They import the built package, as users do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { URL } from 'node:url';
import { extractWithOcr } from './ocr.mjs';
import { toSearchRecords } from './rag.mjs';
import { extractRedacted, mask, redact } from './redaction.mjs';
import { handleUpload } from './upload.mjs';

const read = (path) => new Uint8Array(readFileSync(new URL(`../${path}`, import.meta.url)));
const encode = (text) => new TextEncoder().encode(text);

test('RAG: one record per chunk, with heading context, ids and locations', async () => {
  const { format, records } = await toSearchRecords(read('corpus/docx/headings-outline.docx'), {
    filename: 'headings-outline.docx',
    maxSize: 200,
  });
  assert.equal(format, 'docx');
  assert.ok(records.length > 1);
  assert.equal(new Set(records.map((record) => record.id)).size, records.length);
  for (const record of records) {
    assert.ok(record.text.length <= 200);
    assert.ok(record.locations.length > 0);
  }
  assert.ok(records.some((record) => record.context.length > 0));
});

test('upload: text for a good file, and an HTTP status for every error', async () => {
  const ok = await handleUpload(read('corpus/xlsx/cell-types.xlsx'), { filename: 'cell-types.xlsx' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.format, 'xlsx');
  assert.ok(ok.body.text.length > 0);
  const cases = [
    ['hostile/misc/wrong-executable.pdf', 415, 'UNSUPPORTED_FORMAT'],
    ['hostile/docx/document-bomb.docx', 413, 'LIMIT_EXCEEDED'],
    ['hostile/doc/encrypted.doc', 422, 'ENCRYPTED'],
    ['hostile/zip/truncated-central.zip', 422, 'CORRUPT_FILE'],
  ];
  for (const [path, status, error] of cases) {
    const answer = await handleUpload(read(path), { filename: path.split('/').pop() });
    assert.deepEqual(answer, { status, body: { error } }, path);
  }
  // A nested bomb is only listed, never opened, with children: 'list'.
  assert.equal((await handleUpload(read('hostile/zip/bomb-42k.zip'))).status, 200);
  const big = await handleUpload(new Uint8Array(11 * 1024 * 1024), { filename: 'big.bin' });
  assert.deepEqual(big, { status: 413, body: { error: 'LIMIT_EXCEEDED' } });
});

test('redaction: masks addresses and ID numbers everywhere, and drops authors', async () => {
  assert.equal(mask('Write to ada.l@example.invalid or 123-45-6789.'), 'Write to [email] or [id].');
  assert.equal(mask('Card 4111 1111 1111 1111 expires.'), 'Card [card] expires.');
  assert.equal(mask('Room 12, phone extension 4521.'), 'Room 12, phone extension 4521.');
  const html = encode(
    '<!doctype html><h1>Contact ada@example.invalid</h1><p>SSN <b>123-45-6789</b> on file.</p>' +
      '<ul><li>grace@example.invalid<ul><li>987-65-4321</li></ul></li></ul>' +
      '<table><caption>IDs 111-22-3333</caption><tr><td>bob@example.invalid</td></tr></table><img alt="mail eve@example.invalid">',
  );
  const doc = await extractRedacted(html, { runs: true });
  const json = JSON.stringify(doc.blocks);
  for (const secret of ['@example.invalid', '123-45-6789', '987-65-4321', '111-22-3333'])
    assert.ok(!json.includes(secret), secret);
  assert.ok(json.includes('[email]') && json.includes('[id]'));
  const paragraph = doc.blocks.find((block) => block.kind === 'paragraph');
  assert.equal(paragraph.runs.map((run) => run.text).join(''), paragraph.text);
  // Masking is linear: a long line with no address finishes at once.
  const started = performance.now();
  mask('a'.repeat(200_000));
  assert.ok(performance.now() - started < 1_000);
  assert.equal(redact({ kind: 'image', loc: {} }).kind, 'image');
});

test('OCR: the bytes of every embedded picture, and of a standalone image', async () => {
  const ocr = async (bytes, mimeType) => `${mimeType}:${bytes.length}`;
  const docx = await extractWithOcr(read('corpus/docx/revisions-images.docx'), {
    filename: 'revisions-images.docx',
    ocr,
  });
  assert.deepEqual(
    docx.images.map((image) => image.text),
    ['image/png:70', 'image/png:70'],
  );
  assert.equal(docx.needsOcr, false);
  const png = read('corpus/image/gradient.png');
  const image = await extractWithOcr(png, { filename: 'gradient.png', ocr });
  assert.deepEqual(image.images, [{ ref: undefined, alt: undefined, text: `image/png:${png.length}` }]);
});

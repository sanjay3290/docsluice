import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createFixtures } from '../../bench/generate.mjs';

const packageRequire = createRequire(resolve(import.meta.dirname, '../../packages/docsluice/package.json'));
const { unzipSync, strFromU8 } = packageRequire('fflate');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('generated benchmark inputs are deterministic and meet their target workloads', () => {
  const first = createFixtures();
  const second = createFixtures();

  assert.equal(first.docx.byteLength, 5 * 1024 * 1024);
  assert.equal(first.manifest.fixtures.docx.paragraphs, 10_000);
  assert.equal(first.manifest.fixtures.xlsx.rows, 50_000);
  assert.equal(first.manifest.fixtures.pdf.pages, 100);
  assert.deepEqual(
    Object.keys(first)
      .filter((key) => key !== 'manifest')
      .sort(),
    ['docx', 'pdf', 'xlsx'],
  );
  for (const name of ['docx', 'xlsx', 'pdf']) assert.equal(hash(first[name]), hash(second[name]));

  const sheet = strFromU8(unzipSync(first.xlsx)['xl/worksheets/sheet1.xml']);
  assert.equal((sheet.match(/<row\b/g) ?? []).length, 50_000);
  assert.match(sheet, /R00001/);
  assert.match(sheet, /R50000/);

  const pdf = strFromU8(first.pdf);
  assert.match(pdf, /\/Count 100\b/);
  assert.match(pdf, /PAGE-001/);
  assert.match(pdf, /PAGE-100/);
});

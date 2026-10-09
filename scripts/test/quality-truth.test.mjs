import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTruthMarkdown, readTruthFile } from '../quality/truth.mjs';

function truthMarkdown(overrides = {}) {
  const source = overrides.source ?? 'corpus/sample.txt';
  const sourceSha256 = overrides.sourceSha256 ?? 'a'.repeat(64);
  const format = overrides.format ?? 'doc';
  const reviewStatus = overrides.reviewStatus ?? 'pending';
  return `---\nschema: docsluice-quality-truth-v1\nsource: ${source}\nsourceSha256: ${sourceSha256}\nformat: ${format}\nreviewStatus: ${reviewStatus}\n---\n## Text blocks\n\n\`\`\`json\n["alpha", "omega"]\n\`\`\`\n## Tables\n\n\`\`\`json\n[{"index":0,"cells":[{"row":0,"column":0,"text":"cell"}]}]\n\`\`\`\n## Reading order\n\n\`\`\`json\n[{"kind":"text","index":0},{"kind":"cell","table":0,"row":0,"column":0},{"kind":"text","index":1}]\n\`\`\`\n`;
}

test('parses strict plain-Markdown truth metadata and ordered content', () => {
  const truth = parseTruthMarkdown(truthMarkdown());
  assert.deepEqual(truth, {
    schema: 'docsluice-quality-truth-v1',
    source: 'corpus/sample.txt',
    sourceSha256: 'a'.repeat(64),
    format: 'doc',
    reviewStatus: 'pending',
    textBlocks: ['alpha', 'omega'],
    tables: [{ index: 0, cells: [{ row: 0, column: 0, text: 'cell' }] }],
    readingOrder: [
      { kind: 'text', index: 0 },
      { kind: 'cell', table: 0, row: 0, column: 0 },
      { kind: 'text', index: 1 },
    ],
  });
});

test('rejects prototype-like schema keys and unknown metadata', () => {
  assert.throws(
    () =>
      parseTruthMarkdown(truthMarkdown().replace('["alpha", "omega"]', '[{"__proto__":{"polluted":true}}]')),
    /text blocks/,
  );
  assert.throws(
    () =>
      parseTruthMarkdown(
        truthMarkdown().replace('reviewStatus: pending', 'reviewStatus: pending\nextra: true'),
      ),
    /metadata/,
  );
  assert.equal(Object.prototype.polluted, undefined);
});

test('rejects traversal paths, unsupported formats, duplicate references, and malformed tables', () => {
  assert.throws(() => parseTruthMarkdown(truthMarkdown({ source: 'corpus/../secret.txt' })), /source path/);
  assert.throws(() => parseTruthMarkdown(truthMarkdown({ format: 'xlsx-malicious' })), /format/);
  assert.throws(
    () =>
      parseTruthMarkdown(
        truthMarkdown().replace(
          '[{"kind":"text","index":0},{"kind":"cell","table":0,"row":0,"column":0},{"kind":"text","index":1}]',
          '[{"kind":"text","index":0},{"kind":"text","index":0},{"kind":"cell","table":0,"row":0,"column":0},{"kind":"text","index":1}]',
        ),
      ),
    /reading order/,
  );
  assert.throws(
    () =>
      parseTruthMarkdown(
        truthMarkdown().replace(
          '[{"index":0,"cells":[{"row":0,"column":0,"text":"cell"}]}]',
          '[{"index":0,"cells":[{"row":-1,"column":0,"text":"cell"}]}]',
        ),
      ),
    /table cell/,
  );
});

test('rejects sparse truth table ordinals instead of scoring identical cells as mismatches', () => {
  const sparse = truthMarkdown().replace('"index":0', '"index":7').replaceAll('"table":0', '"table":7');
  assert.throws(() => parseTruthMarkdown(sparse), /table indexes/);
});

test('source hash verification binds truth to the exact input file', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'docsluice-quality-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const truthDirectory = join(root, 'corpus', 'package-a-truth');
  await mkdir(truthDirectory, { recursive: true });
  const sourceBytes = Buffer.from('sample');
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  await mkdir(join(root, 'corpus'), { recursive: true });
  await writeFile(join(root, 'corpus', 'sample.txt'), sourceBytes);
  const markdown = truthMarkdown({ sourceSha256: digest });
  const path = join(truthDirectory, 'sample.truth.md');
  await writeFile(path, markdown);

  const loaded = await readTruthFile(path, root);
  assert.equal(loaded.truth.sourceSha256, digest);
  await writeFile(join(root, 'corpus', 'sample.txt'), 'changed');
  await assert.rejects(readTruthFile(path, root), /SHA-256/);
});

test('unreviewed truth cannot self-upgrade and must not claim a human check', () => {
  assert.equal(parseTruthMarkdown(truthMarkdown()).reviewStatus, 'pending');
  assert.throws(() => parseTruthMarkdown(truthMarkdown({ reviewStatus: 'hand-checked' })), /reviewStatus/);
});

test('source paths cannot escape through a symlinked corpus directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'docsluice-quality-link-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const truthDirectory = join(root, 'corpus', 'package-a-truth');
  const outside = join(root, 'outside');
  await mkdir(truthDirectory, { recursive: true });
  await mkdir(outside);
  const bytes = Buffer.from('outside');
  await writeFile(join(outside, 'sample.txt'), bytes);
  await symlink(outside, join(root, 'corpus', 'link'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const path = join(truthDirectory, 'sample.truth.md');
  await writeFile(path, truthMarkdown({ source: 'corpus/link/sample.txt', sourceSha256: digest }));

  await assert.rejects(readTruthFile(path, root), /symbolic links/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { generateSupportMatrix } from '../docs-support.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function temporaryRepo() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docsluice-support-'));
  await mkdir(path.join(root, 'corpus'), { recursive: true });
  await mkdir(path.join(root, 'docs'), { recursive: true });
  await writeFile(
    path.join(root, 'docs', 'prd.md'),
    '| ID | Requirement | Pri |\n|----|-------------|-----|\n| IN-1 | Input bytes | P0 |\n| DOC-2 | Heading structure | P0 |\n| IN-9 | Detect only | P0 |\n',
  );
  return root;
}

async function addFixture(root, file, requirements = 'IN-1') {
  const absolute = path.join(root, 'corpus', file);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, 'fixture');
  await writeFile(
    `${absolute}.license`,
    `SPDX-License-Identifier: CC0-1.0\nSource: synthetic test fixture\nRequirements: ${requirements}\n`,
  );
  return absolute;
}

test('lists every P0 requirement and separates fixture tags from golden presence', async () => {
  const root = await temporaryRepo();
  try {
    const file = await addFixture(root, 'text/example.txt', 'IN-1');
    await writeFile(`${file}.expected.json`, '{}');
    await writeFile(`${file}.expected.md`, 'example');

    const matrix = await generateSupportMatrix({ root });
    assert.match(matrix, /\| DOC-2 \| Heading structure \| Not covered \|/);
    assert.match(
      matrix,
      /\| IN-1 \| Input bytes \| <code>text\/example\.txt<\/code> \| <code>text\/example\.txt<\/code>: JSON and Markdown present \|/,
    );
    assert.match(matrix, /Fixture requirement tags are attribution metadata, not proof of support\./);
    assert.doesNotMatch(matrix, /\| Supported \|/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects corpus files without a license sidecar', async () => {
  const root = await temporaryRepo();
  try {
    const file = path.join(root, 'corpus', 'text', 'unlicensed.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'unlicensed');
    await assert.rejects(generateSupportMatrix({ root }), /missing license/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('requires nonempty Requirements metadata in every corpus license', async () => {
  const root = await temporaryRepo();
  try {
    const file = await addFixture(root, 'text/no-requirements.txt', 'IN-1');
    for (const requirementLine of ['', 'Requirements:   \n']) {
      await writeFile(
        `${file}.license`,
        `SPDX-License-Identifier: CC0-1.0\nSource: synthetic test fixture\n${requirementLine}`,
      );
      await assert.rejects(generateSupportMatrix({ root }), /Requirements field/i);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects invalid requirement tags and corpus symlinks', async () => {
  const root = await temporaryRepo();
  try {
    const file = await addFixture(root, 'text/bad.txt', 'IN-1 | injected');
    await assert.rejects(generateSupportMatrix({ root }), /invalid Requirements/i);
    await writeFile(
      `${file}.license`,
      'SPDX-License-Identifier: CC0-1.0\nSource: synthetic test fixture\nRequirements: UNKNOWN-999\n',
    );
    await assert.rejects(generateSupportMatrix({ root }), /unknown requirement tag/i);
    await rm(file, { force: true });
    await rm(`${file}.license`, { force: true });
    const outside = path.join(root, 'outside.txt');
    await writeFile(outside, 'outside');
    await symlink(outside, path.join(root, 'corpus', 'escape.txt'));
    await assert.rejects(generateSupportMatrix({ root }), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('escapes corpus paths before placing them in Markdown tables', async () => {
  const root = await temporaryRepo();
  try {
    await addFixture(root, 'text/a|b`<c>.txt', 'IN-1');
    const matrix = await generateSupportMatrix({ root });
    assert.match(matrix, /<code>text\/a&#124;b&#96;&lt;c&gt;\.txt<\/code>/);
    assert.doesNotMatch(matrix, /<code>[^<]*`/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ignores corpus metadata files but rejects them when they are symlinks', async () => {
  const root = await temporaryRepo();
  try {
    await addFixture(root, 'text/with-metadata.txt', 'IN-1');
    await writeFile(path.join(root, 'corpus', '.gitkeep'), '');
    await writeFile(path.join(root, 'corpus', 'text', '.gitattributes'), '*.txt text\n');
    await generateSupportMatrix({ root });

    await rm(path.join(root, 'corpus', '.gitkeep'));
    await symlink(path.join(root, 'docs', 'prd.md'), path.join(root, 'corpus', '.gitkeep'));
    await assert.rejects(generateSupportMatrix({ root }), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation is deterministic and --check detects committed-page drift', async () => {
  const root = await temporaryRepo();
  try {
    await addFixture(root, 'text/ordered.txt', 'DOC-2, IN-1');
    const first = await generateSupportMatrix({ root });
    const second = await generateSupportMatrix({ root });
    assert.equal(first, second);
    const outputPath = path.join(root, 'docs', 'formats', 'support-matrix.md');
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, first);

    const result = spawnSync(process.execPath, ['scripts/docs-support.mjs', '--check', '--root', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    await writeFile(outputPath, `${first}drift\n`);
    const drift = spawnSync(process.execPath, ['scripts/docs-support.mjs', '--check', '--root', root], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /out of date/i);
    assert.equal(await readFile(outputPath, 'utf8'), `${first}drift\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('repository P0 inventory has a fixture or an explicit not-covered row', async () => {
  const matrix = await generateSupportMatrix({ root: repoRoot });
  const prd = await readFile(path.join(repoRoot, 'docs/prd.md'), 'utf8');
  const ids = new Set();
  for (const line of prd.split(/\r?\n/u)) {
    if (!/^\|\s*[A-Z][A-Z0-9]*-\d+\s*\|/u.test(line) || !/\|\s*P0\s*\|\s*$/u.test(line)) continue;
    ids.add(line.split('|')[1].trim());
  }
  for (const id of ids) {
    const row = matrix.split(/\r?\n/u).find((line) => line.startsWith(`| ${id} |`));
    assert.ok(row, `matrix must include ${id}`);
    assert.match(row, /\| (?:Not covered|<code>)/u, `${id} needs tagged fixture inventory or Not covered`);
  }
  assert.ok(ids.size > 0, 'PRD P0 requirement inventory must not be empty');
});

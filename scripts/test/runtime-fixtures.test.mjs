import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixtureSources as sources, generateFixtureModule } from '../runtime-fixtures.mjs';
import {
  loadRuntimeFixtures,
  runtimeFixtureSourceHashes,
} from '../../packages/docsluice/test-runtime/fixtures.generated.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('embedded browser/Worker fixtures are byte-identical to authoritative sources and hashed', async () => {
  const fixtures = loadRuntimeFixtures();
  for (const [name, source] of Object.entries(sources)) {
    const original = new Uint8Array(await readFile(path.join(repoRoot, source)));
    assert.deepEqual(fixtures[name], original, `${name} fixture bytes must match ${source}`);
    assert.equal(
      runtimeFixtureSourceHashes[name],
      createHash('sha256').update(original).digest('hex'),
      `${name} source hash must match ${source}`,
    );
  }
});

test('generated fixture module is deterministic', async () => {
  assert.equal(
    await generateFixtureModule({ root: repoRoot }),
    await generateFixtureModule({ root: repoRoot }),
  );
});

test('fixture module --check detects source drift', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'docsluice-runtime-fixtures-'));
  try {
    for (const relative of [
      ...Object.values(sources),
      'packages/docsluice/test-runtime/fixtures.generated.mjs',
    ]) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      if (relative.endsWith('.mjs')) await writeFile(target, await generateFixtureModule({ root: repoRoot }));
      else await copyFile(path.join(repoRoot, relative), target);
    }
    const args = ['scripts/runtime-fixtures.mjs', '--check', '--root', root];
    const valid = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(valid.status, 0, valid.stderr);

    const changed = path.join(root, sources.hostileXml);
    await writeFile(changed, Buffer.concat([await readFile(changed), Buffer.from([0x20])]));
    const drift = spawnSync(process.execPath, args, { cwd: repoRoot, encoding: 'utf8' });
    assert.equal(drift.status, 1);
    assert.match(drift.stderr, /out of date/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

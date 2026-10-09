import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { test } from 'node:test';
import { buildFixtures, validatePlan } from './build.mjs';

const fixture = {
  source: 'src/sample.fodt',
  formats: ['docx', 'odt', 'pdf'],
  requirements: ['DOC-2'],
};

async function setup(t, behavior = 'ok') {
  const root = await mkdtemp(path.join(tmpdir(), 'docsluice-corpus-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts/corpus/src'), { recursive: true });
  await writeFile(path.join(root, 'scripts/corpus/src/sample.fodt'), '<office:document/>');
  const executable = path.join(root, 'fake soffice');
  const code = `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('LibreOffice 26.8 test');
  process.exit(0);
}
const mode = ${JSON.stringify(behavior)};
if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'fail' || (mode === 'late-fail' && args[args.indexOf('--convert-to') + 1].startsWith('pdf:'))) { process.exit(7); }
else if (mode !== 'missing') {
  const format = args[args.indexOf('--convert-to') + 1].split(':')[0];
  const dir = args[args.indexOf('--outdir') + 1];
  const name = path.basename(args.at(-1), path.extname(args.at(-1)));
  const signature = mode === 'invalid' ? 'invalid' : format === 'pdf' ? '%PDF-1.7\\n' : 'PK\\x03\\x04';
  writeFileSync(path.join(dir, name + '.' + format), signature + 'fixture-test-output');
}
`;
  // .mjs is unnecessary for a directly spawned executable: extensionless scripts
  // with ESM syntax run in Node 24, the development runtime.
  await writeFile(executable, code);
  await chmod(executable, 0o755);
  return { root, soffice: executable, plan: [fixture], timeoutMs: 2000 };
}

test('plan rejects traversal, format mismatch, duplicate outputs and empty plans', () => {
  for (const plan of [
    [],
    [{ ...fixture, source: '../sample.fodt' }],
    [{ ...fixture, source: 'src/../sample.fodt' }],
    [{ ...fixture, formats: ['xlsm'] }],
    [{ ...fixture, formats: ['xlsx'] }],
    [{ ...fixture, formats: ['docx', 'docx'] }],
    [{ ...fixture, requirements: ['fake'] }],
    [{ ...fixture, requirements: [] }],
    [fixture, fixture],
  ])
    assert.throws(() => validatePlan(plan));
  assert.equal(validatePlan([fixture]).length, 3);
});

test('conversion installs all formats and records license/version/source/hash', async (t) => {
  const opts = await setup(t);
  const result = await buildFixtures(opts);
  assert.equal(result.outputs.length, 3);
  for (const output of result.outputs) {
    const file = path.join(opts.root, output.file);
    assert.ok((await readFile(file)).length > 0);
    const license = await readFile(file + '.license', 'utf8');
    assert.match(license, /SPDX-License-Identifier: CC0-1.0/);
    assert.match(license, /LibreOffice 26.8 test/);
    assert.match(license, /scripts\/corpus\/src\/sample.fodt/);
    assert.match(license, /Requirements: DOC-2/);
    assert.match(output.sha256, /^[a-f0-9]{64}$/);
  }
  assert.equal(result.version, 'LibreOffice 26.8 test');
});

test('nonzero conversion exit fails without replacing committed fixtures', async (t) => {
  const opts = await setup(t, 'fail');
  await mkdir(path.join(opts.root, 'corpus/docx'), { recursive: true });
  await writeFile(path.join(opts.root, 'corpus/docx/sample.docx'), 'previous-fixture');
  await assert.rejects(buildFixtures(opts), /conversion failed.*7/i);
  assert.equal(await readFile(path.join(opts.root, 'corpus/docx/sample.docx'), 'utf8'), 'previous-fixture');
});

test('a successful process with no output fails instead of accepting stale output', async (t) => {
  const opts = await setup(t, 'missing');
  await mkdir(path.join(opts.root, 'corpus/docx'), { recursive: true });
  await writeFile(path.join(opts.root, 'corpus/docx/sample.docx'), 'stale');
  await assert.rejects(buildFixtures(opts), /missing output/i);
  assert.equal(await readFile(path.join(opts.root, 'corpus/docx/sample.docx'), 'utf8'), 'stale');
});

test('invalid file signature fails before output installation', async (t) => {
  const opts = await setup(t, 'invalid');
  await assert.rejects(buildFixtures(opts), /signature/i);
  await assert.rejects(access(path.join(opts.root, 'corpus/docx/sample.docx')));
});

test('missing executable is reported explicitly', async (t) => {
  const opts = await setup(t);
  opts.soffice = path.join(opts.root, 'absent-soffice');
  await assert.rejects(buildFixtures(opts), /LibreOffice.*ENOENT/i);
});

test('conversion watchdog terminates a hanging executable', async (t) => {
  const opts = await setup(t, 'hang');
  opts.timeoutMs = 100;
  const started = performance.now();
  await assert.rejects(buildFixtures(opts), /timeout/i);
  assert.ok(performance.now() - started < 2000);
});

test('missing source fails before launching LibreOffice', async (t) => {
  const opts = await setup(t);
  await rm(path.join(opts.root, 'scripts/corpus/src/sample.fodt'));
  await assert.rejects(buildFixtures(opts), /source/i);
});

test('output root can be explicitly selected without shell interpretation', async (t) => {
  const opts = await setup(t);
  const result = await buildFixtures({
    ...opts,
    outputRoot: path.join(opts.root, 'outputs with spaces'),
  });
  assert.equal(result.outputs.length, 3);
  await access(path.join(opts.root, 'outputs with spaces/docx/sample.docx'));
});

test('destination staging symlink cannot overwrite an unrelated file', async (t) => {
  const opts = await setup(t);
  const dir = path.join(opts.root, 'corpus/docx');
  await mkdir(dir, { recursive: true });
  const unrelated = path.join(opts.root, 'unrelated');
  await writeFile(unrelated, 'untouched');
  await symlink(unrelated, path.join(dir, 'sample.docx.docsluice-building'));
  await buildFixtures(opts);
  assert.equal(await readFile(unrelated, 'utf8'), 'untouched');
});

test('later conversion failure leaves all existing outputs untouched', async (t) => {
  const opts = await setup(t, 'late-fail');
  for (const format of fixture.formats) {
    await mkdir(path.join(opts.root, 'corpus', format), { recursive: true });
    await writeFile(path.join(opts.root, 'corpus', format, 'sample.' + format), 'prior-' + format);
  }
  await assert.rejects(buildFixtures(opts), /conversion failed.*7/i);
  for (const format of fixture.formats) {
    assert.equal(
      await readFile(path.join(opts.root, 'corpus', format, 'sample.' + format), 'utf8'),
      'prior-' + format,
    );
  }
});

test('source symlink outside the corpus source tree is rejected', async (t) => {
  const opts = await setup(t);
  const source = path.join(opts.root, 'scripts/corpus/src/sample.fodt');
  await rm(source);
  const external = path.join(opts.root, 'outside.fodt');
  await writeFile(external, '<office:document/>');
  await symlink(external, source);
  await assert.rejects(buildFixtures(opts), /escapes source root/i);
});

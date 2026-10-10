import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeJazzer, TARGETS } from './fuzz-run.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new globalThis.URL('../', import.meta.url));
const jazzerBin = process.env.DOCSLUICE_JAZZER_BIN ?? join(root, 'node_modules/.bin/jazzer');

const fakeEngine = `
import { writeFile } from 'node:fs/promises';
const args = process.argv.slice(2);
const prefix = args.find((arg) => arg.startsWith('-artifact_prefix='))?.slice('-artifact_prefix='.length);
if (process.env.FAKE_JAZZER_MODE === 'crash') {
  await writeFile(prefix + 'planted-crash', Buffer.from('reproducer'));
  process.exitCode = 77;
} else if (process.env.FAKE_JAZZER_MODE === 'hang') {
  globalThis.setInterval(() => {}, 1000);
} else if (process.env.FAKE_JAZZER_MODE === 'memory') {
  const memory = Buffer.alloc(256 * 1024 * 1024, 0x41);
  globalThis.setInterval(() => { if (memory[0] === 0) process.exitCode = 1; }, 1000);
}
`;

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'docsluice-fuzz-test-'));
  const engine = join(directory, 'engine.mjs');
  await writeFile(engine, fakeEngine);
  return { directory, engine, artifacts: join(directory, 'artifacts') };
}

test('runner records a successful seeded invocation', async () => {
  const paths = await fixture();
  try {
    const result = await executeJazzer({
      target: 'xml',
      seconds: 1,
      jazzerBin: process.execPath,
      fuzzTarget: paths.engine,
      artifacts: paths.artifacts,
    });
    assert.ok(result.seedCount > 0);
    const run = JSON.parse(await readFile(join(result.artifactDir, 'run.json'), 'utf8'));
    assert.equal(run.exitCode, 0);
    assert.equal(run.failure, null);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('runner preserves an unexpected crash input and fails the run', async () => {
  const paths = await fixture();
  try {
    let error;
    try {
      await executeJazzer({
        target: 'xml',
        seconds: 1,
        jazzerBin: process.execPath,
        fuzzTarget: paths.engine,
        artifacts: paths.artifacts,
        extraEnv: { FAKE_JAZZER_MODE: 'crash' },
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'a nonzero engine status must fail the run');
    assert.match(error.message, /exited with 77/);
    assert.equal(error.exitCode, 77);
    assert.equal(await readFile(join(error.artifactDir, 'crash-planted-crash'), 'utf8'), 'reproducer');
    const run = JSON.parse(await readFile(join(error.artifactDir, 'run.json'), 'utf8'));
    assert.match(run.failure, /crash or failed run/);
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('runner kills a hung target at the watchdog deadline', async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      executeJazzer({
        target: 'xml',
        seconds: 1,
        watchdogMs: 300,
        jazzerBin: process.execPath,
        fuzzTarget: paths.engine,
        artifacts: paths.artifacts,
        extraEnv: { FAKE_JAZZER_MODE: 'hang' },
      }),
      /watchdog timed out/,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('runner kills a target that exceeds the process-tree memory cap', async () => {
  const paths = await fixture();
  try {
    await assert.rejects(
      executeJazzer({
        target: 'xml',
        seconds: 1,
        memoryMb: 128,
        watchdogMs: 5_000,
        jazzerBin: process.execPath,
        fuzzTarget: paths.engine,
        artifacts: paths.artifacts,
        extraEnv: { FAKE_JAZZER_MODE: 'memory' },
      }),
      /memory cap exceeded/,
    );
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test('compiler diagnostics stay bounded and a stuck compiler is killed', async () => {
  const paths = await fixture();
  const compiler = join(paths.directory, 'noisy-tsc.mjs');
  await writeFile(
    compiler,
    `#!/usr/bin/env node\nprocess.stdout.write('o'.repeat(400000));\nprocess.stderr.write('e'.repeat(400000));\nglobalThis.setInterval(() => {}, 1000);\n`,
  );
  await chmod(compiler, 0o755);
  try {
    let error;
    try {
      await executeJazzer({
        target: 'xml',
        seconds: 1,
        tscBin: compiler,
        compilerTimeoutMs: 300,
        compilerOutputLimitBytes: 1024,
        jazzerBin: process.execPath,
        fuzzTarget: paths.engine,
        artifacts: paths.artifacts,
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'compiler timeout must fail the fuzz run');
    assert.match(error.message, /TypeScript fuzz-source compilation timed out/);
    assert.match(error.message, /truncated/);
    assert.ok(error.message.length < 2_500, 'compiler output retained in the error must be bounded');
  } finally {
    await rm(paths.directory, { recursive: true, force: true });
  }
});

test(
  'Linux RSS monitor fails closed when ps is unavailable',
  { skip: process.platform !== 'linux' },
  async () => {
    const paths = await fixture();
    try {
      let error;
      try {
        await executeJazzer({
          target: 'xml',
          seconds: 1,
          watchdogMs: 5_000,
          psBin: join(paths.directory, 'missing-ps'),
          jazzerBin: process.execPath,
          fuzzTarget: paths.engine,
          artifacts: paths.artifacts,
          extraEnv: { FAKE_JAZZER_MODE: 'hang' },
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, 'an unavailable RSS monitor must fail the run');
      assert.match(error.message, /memory cap monitor could not read/);
      const run = JSON.parse(await readFile(join(error.artifactDir, 'run.json'), 'utf8'));
      assert.equal(run.memoryMonitoring, 'failed');
      assert.equal(run.peakProcessTreeMiB, null);
      assert.match(run.failure, /memory cap monitor could not read/);
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  },
);

test(
  'Jazzer detects a planted exception and writes a reproducer',
  {
    skip: !existsSync(jazzerBin) && 'Jazzer.js is not installed',
  },
  async () => {
    const paths = await fixture();
    const seedDirectory = join(paths.directory, 'seed');
    const seed = join(seedDirectory, 'planted');
    await mkdir(seedDirectory, { recursive: true });
    await writeFile(seed, Uint8Array.of(0x42));
    try {
      let error;
      try {
        await executeJazzer({
          target: 'xml',
          seconds: 5,
          jazzerBin,
          fuzzTarget: join(root, 'scripts/fuzz-planted-bug.mjs'),
          artifacts: paths.artifacts,
          seeds: [seed],
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error, 'the planted exception must fail the fuzzer runner');
      assert.match(error.message, /Jazzer.js exited with/);
      assert.ok((await readdir(error.artifactDir)).some((name) => name.startsWith('crash-')));
    } finally {
      await rm(paths.directory, { recursive: true, force: true });
    }
  },
);

test('both fuzz workflows run every registered target', async () => {
  const expected = Object.keys(TARGETS).sort();
  for (const workflow of ['fuzz-pr.yml', 'fuzz-nightly.yml']) {
    const text = await readFile(join(root, '.github/workflows', workflow), 'utf8');
    // The matrix may be inline, wrapped onto the next line, or one name per line with a trailing comma.
    const key = text.indexOf('target:');
    const open = text.indexOf('[', key);
    const close = text.indexOf(']', open);
    assert.ok(key >= 0 && open > key && close > open, `${workflow} has a target matrix`);
    const listed = text
      .slice(open + 1, close)
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
      .sort();
    assert.deepEqual(listed, expected, `${workflow} matrix matches TARGETS`);
  }
});

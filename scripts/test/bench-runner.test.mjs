import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderResults, runChildProcess } from '../../bench/run.mjs';

test('an isolated child returns its actual structured result', async () => {
  const result = await runChildProcess({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify({ status: "ok", textCharacters: 24 }));'],
    timeoutMs: 2_000,
    maxOutputBytes: 1024,
  });
  assert.deepEqual(JSON.parse(result.stdout), { status: 'ok', textCharacters: 24 });
  assert.ok(result.peakRssBytes > 0);
});

test('the watchdog terminates a child that exceeds its time budget', async () => {
  await assert.rejects(
    runChildProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000);'],
      timeoutMs: 50,
      maxOutputBytes: 1024,
    }),
    (error) => error.code === 'BENCH_TIMEOUT',
  );
});

test('the output bound terminates a child that emits an oversized report', async () => {
  await assert.rejects(
    runChildProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(5000));'],
      timeoutMs: 2_000,
      maxOutputBytes: 1024,
    }),
    (error) => error.code === 'BENCH_OUTPUT_LIMIT',
  );
});

test('the RSS watchdog terminates a child that exceeds its process memory ceiling', async () => {
  await assert.rejects(
    runChildProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 5000);'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      maxRssBytes: 1,
    }),
    (error) => error.code === 'BENCH_MEMORY_LIMIT',
  );
});

test('the RSS watchdog fails closed when its process monitor is unavailable', async () => {
  await assert.rejects(
    runChildProcess({
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 5000);'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024,
      readRss: async () => {
        throw new Error('simulated missing ps');
      },
    }),
    (error) => error.code === 'BENCH_RSS_MONITOR_UNAVAILABLE',
  );
});

test('results label unsupported readers as unavailable instead of zero-time passes', () => {
  const markdown = renderResults({
    generatedAt: '2026-10-09T00:00:00.000Z',
    catalog: {
      libraries: {
        docsluice: { version: 'workspace build (0.0.0)', source: 'https://example.test' },
      },
    },
    cases: [{ format: 'pdf', fixture: 'benchmark-100-pages.pdf', libraries: ['docsluice'] }],
    fixtureManifest: {
      generator: 'bench/generate.mjs',
      generatorLicense: 'MIT',
      source: 'synthetic test data',
      zipLibrary: 'fflate',
      fixtures: {
        docx: {
          file: 'benchmark-5mb.docx',
          paragraphs: 3,
          bytes: 100,
          fillerCharacters: 10,
          markerCharacters: 8,
          sha256: 'def',
        },
        pdf: { file: 'benchmark-100-pages.pdf', pages: 100, bytes: 42, sha256: 'abc' },
      },
    },
    repeats: 3,
    timeoutMs: 1000,
    system: { node: 'v24.0.0', platform: 'linux', arch: 'x64', cpuCount: 2, totalMemoryBytes: 1024 },
    samples: [
      {
        format: 'pdf',
        library: 'docsluice',
        status: 'unavailable',
        reason: 'reader-not-implemented',
      },
    ],
  });
  assert.match(markdown, /unavailable/i);
  assert.match(markdown, /reader-not-implemented/);
  assert.doesNotMatch(markdown, /\|\s*0(?:\.0)? ms\s*\|/);
  assert.match(markdown, /not measured/i);
});

test('a real worker child reports the built docsluice PDF reader as unavailable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docsluice-bench-child-'));
  const inputPath = join(directory, 'unsupported.pdf');
  const workerPath = fileURLToPath(new URL('../../bench/worker.mjs', import.meta.url));
  try {
    await writeFile(inputPath, '%PDF-1.4\n%%EOF\n');
    const result = await runChildProcess({
      command: process.execPath,
      args: [
        workerPath,
        'docsluice',
        'pdf',
        inputPath,
        '100',
        '(?<![A-Za-z0-9])PAGE-[0-9]{3}(?![A-Za-z0-9])',
      ],
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.reason, 'reader-not-implemented');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a missing comparator dependency is reported unavailable without timing fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docsluice-bench-dependency-'));
  const inputPath = join(directory, 'input.docx');
  const workerPath = fileURLToPath(new URL('../../bench/worker.mjs', import.meta.url));
  try {
    await writeFile(inputPath, 'synthetic bytes');
    const result = await runChildProcess({
      command: process.execPath,
      args: [workerPath, 'mammoth', 'docx', inputPath, '10000', '(?<![A-Za-z0-9])P[0-9]{5}(?![A-Za-z0-9])'],
      timeoutMs: 5_000,
      maxOutputBytes: 1024 * 1024,
      env: { ...process.env, DOCSLUICE_BENCH_NODE_MODULES: '' },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'unavailable');
    assert.equal(report.reason, 'dependency-not-installed');
    assert.equal('durationMs' in report, false);
    assert.equal('peakRssBytes' in report, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

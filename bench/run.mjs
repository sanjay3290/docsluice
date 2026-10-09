import { execFile as execFileCallback, spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, arch, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';
import { generateFixtures } from './generate.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPOSITORY = resolve(HERE, '..');
const FIXTURES = resolve(HERE, 'fixtures');
const CATALOG = resolve(HERE, 'comparators.json');
const WORKER = resolve(HERE, 'worker.mjs');
const RESULTS = resolve(REPOSITORY, 'docs/bench/results.md');
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RSS_BYTES = 1024 * 1024 * 1024;
const RSS_POLL_INTERVAL_MS = 25;

function benchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Return Linux RSS summed across a process group, or fail closed. */
export function readProcessGroupRss(processGroupId, signal) {
  if (process.platform !== 'linux') {
    return Promise.reject(benchError('BENCH_RSS_MONITOR_UNAVAILABLE', 'The RSS monitor requires Linux.'));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    execFileCallback(
      'ps',
      ['-e', '-o', 'pgid=,rss='],
      { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 2_000, signal },
      (error, stdout) => {
        if (error) {
          rejectPromise(
            benchError('BENCH_RSS_MONITOR_UNAVAILABLE', `Could not sample process RSS: ${error.message}`),
          );
          return;
        }
        let totalRssKiB = 0;
        let matches = 0;
        for (const line of stdout.split('\n')) {
          const fields = line.trim().split(/\s+/);
          if (fields.length !== 2 || Number(fields[0]) !== processGroupId) continue;
          const rssKiB = Number(fields[1]);
          if (!Number.isSafeInteger(rssKiB) || rssKiB < 0) {
            rejectPromise(
              benchError('BENCH_RSS_MONITOR_UNAVAILABLE', 'The RSS monitor returned an invalid sample.'),
            );
            return;
          }
          totalRssKiB += rssKiB;
          matches += 1;
        }
        if (matches === 0) {
          resolvePromise(undefined);
          return;
        }
        resolvePromise(totalRssKiB * 1024);
      },
    );
  });
}

/** Run one isolated child with wall-time, output, and process-RSS bounds. */
export function runChildProcess({
  command,
  args,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_OUTPUT_LIMIT_BYTES,
  maxRssBytes = DEFAULT_MAX_RSS_BYTES,
  readRss = readProcessGroupRss,
  rssPollIntervalMs = RSS_POLL_INTERVAL_MS,
  env = process.env,
}) {
  if (process.platform !== 'linux') {
    return Promise.reject(
      benchError('BENCH_RSS_MONITOR_UNAVAILABLE', 'Benchmark children require the Linux RSS monitor.'),
    );
  }
  if (!Number.isSafeInteger(maxRssBytes) || maxRssBytes < 1) {
    return Promise.reject(
      benchError('BENCH_CONFIG_INVALID', 'The RSS ceiling must be a positive byte count.'),
    );
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let pendingError;
    let rssPoll;
    let rssInFlight = false;
    let rssSamplePromise;
    let activeRssController;
    let sampledRss = false;
    let peakRssBytes = 0;
    let timer;
    const killProcessGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    const cleanup = (abortMonitor = false) => {
      clearTimeout(timer);
      clearInterval(rssPoll);
      if (abortMonitor) activeRssController?.abort();
    };
    const terminate = (error) => {
      if (settled || pendingError) return;
      pendingError = error;
      cleanup(true);
      killProcessGroup();
    };
    const sampleRss = async () => {
      if (settled || pendingError || rssInFlight || !child.pid) return;
      rssInFlight = true;
      const controller = new globalThis.AbortController();
      activeRssController = controller;
      try {
        const rssBytes = await readRss(child.pid, controller.signal);
        if (rssBytes === undefined) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, RSS_POLL_INTERVAL_MS));
          if (child.exitCode !== null || child.signalCode !== null) return;
          throw benchError('BENCH_RSS_MONITOR_UNAVAILABLE', 'The RSS monitor returned no process sample.');
        }
        sampledRss = true;
        peakRssBytes = Math.max(peakRssBytes, rssBytes);
        if (rssBytes > maxRssBytes) {
          terminate(
            benchError(
              'BENCH_MEMORY_LIMIT',
              `Process group RSS exceeded ${maxRssBytes} bytes (sampled ${rssBytes} bytes).`,
            ),
          );
        }
      } catch (error) {
        terminate(
          error.code === 'BENCH_RSS_MONITOR_UNAVAILABLE'
            ? error
            : benchError('BENCH_RSS_MONITOR_UNAVAILABLE', `Could not sample process RSS: ${error.message}`),
        );
      } finally {
        if (activeRssController === controller) activeRssController = undefined;
        rssInFlight = false;
      }
    };
    const startRssSample = () => {
      if (settled || pendingError || rssInFlight || !child.pid) return;
      rssSamplePromise = sampleRss();
    };
    const collect = (target, stream) => {
      stream.on('data', (chunk) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          terminate(benchError('BENCH_OUTPUT_LIMIT', `Child output exceeded ${maxOutputBytes} bytes.`));
          return;
        }
        target.push(chunk);
      });
    };
    collect(stdout, child.stdout);
    collect(stderr, child.stderr);
    child.on('error', (error) => terminate(error));
    timer = setTimeout(
      () => terminate(benchError('BENCH_TIMEOUT', `Child exceeded ${timeoutMs} ms.`)),
      timeoutMs,
    );
    rssPoll = setInterval(startRssSample, rssPollIntervalMs);
    startRssSample();
    child.on('close', async (code, signal) => {
      settled = true;
      cleanup(true);
      await rssSamplePromise;
      if (pendingError) {
        rejectPromise(pendingError);
        return;
      }
      if (!sampledRss) {
        rejectPromise(
          benchError('BENCH_RSS_MONITOR_UNAVAILABLE', 'The child exited before RSS could be sampled.'),
        );
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal,
        peakRssBytes,
      };
      if (code !== 0) {
        const error = benchError('BENCH_CHILD_EXIT', `Child exited ${code ?? signal}.`);
        Object.assign(error, result);
        rejectPromise(error);
      } else resolvePromise(result);
    });
  });
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  if (ordered.length === 0) return undefined;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function formatMilliseconds(value) {
  return value === undefined ? '—' : `${value.toFixed(1)} ms`;
}

function formatBytes(value) {
  if (value === undefined) return '—';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / 1024).toFixed(0)} KiB`;
}

function statusDescription(samples) {
  const failed = samples.find((sample) => sample.status !== 'ok');
  if (failed) {
    const reason = failed.reason ? ` (${failed.reason})` : '';
    const detail = failed.detail ? ` — ${failed.detail}` : '';
    return `**${failed.status.toUpperCase()}**${reason}${detail}`;
  }
  return `valid (${samples[0].markerCount.toLocaleString('en-US')} markers)`;
}

/** Render reports without translating unavailable results into numeric passes. */
export function renderResults(report) {
  const { catalog, cases, fixtureManifest, samples, system, repeats, timeoutMs } = report;
  const lines = [
    '# Benchmark results',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    'This page is generated by `node bench/run.mjs`. Measurements come from separate Node child processes per library, input, and repetition. The benchmark records extraction time and the maximum sampled absolute RSS across the child process group; unavailable readers and invalid outputs have no performance result.',
    '',
    `Machine: Node ${system.node}, ${system.platform}/${system.arch}, ${system.cpuCount} CPU(s), ${formatBytes(system.totalMemoryBytes)} RAM. Repetitions: ${repeats}; per-child timeout: ${timeoutMs} ms.`,
    `Per-child RSS ceiling: ${formatBytes(report.maxRssBytes)}; RSS is sampled every ${RSS_POLL_INTERVAL_MS} ms across the isolated process group.`,
    '',
    '## Inputs',
    '',
    '| Input | Semantic workload | Size | SHA-256 |',
    '|---|---:|---:|---|',
  ];
  for (const fixture of Object.values(fixtureManifest.fixtures)) {
    const workload = fixture.paragraphs
      ? `${fixture.paragraphs.toLocaleString('en-US')} marked paragraphs`
      : fixture.rows
        ? `${fixture.rows.toLocaleString('en-US')} marked rows`
        : `${fixture.pages.toLocaleString('en-US')} marked text pages`;
    lines.push(`| ${fixture.file} | ${workload} | ${formatBytes(fixture.bytes)} | \`${fixture.sha256}\` |`);
  }
  lines.push(
    '',
    '## Results',
    '',
    '| Input | Library | Semantic extraction | Median time | Median peak RSS |',
    '|---|---|---|---:|---:|',
  );
  for (const benchmarkCase of cases) {
    const fixture = fixtureManifest.fixtures[benchmarkCase.format];
    for (const libraryName of benchmarkCase.libraries) {
      const group = samples.filter(
        (sample) => sample.format === benchmarkCase.format && sample.library === libraryName,
      );
      const library = catalog.libraries[libraryName];
      const successful = group.filter((sample) => sample.status === 'ok');
      const semantic = statusDescription(group);
      const duration =
        successful.length === group.length
          ? formatMilliseconds(median(successful.map((sample) => sample.durationMs)))
          : '—';
      const peak =
        successful.length === group.length
          ? formatBytes(median(successful.map((sample) => sample.peakRssBytes)))
          : '—';
      lines.push(
        `| ${fixture.file} | [${libraryName} ${library.version}](${library.source}) | ${semantic} | ${duration} | ${peak} |`,
      );
    }
  }
  lines.push('', '## PERF-1 targets', '');
  const targets = [
    { format: 'docx', description: '5 MiB DOCX under 1 s', thresholdMs: 1000 },
    { format: 'xlsx', description: '50,000-row XLSX under 3 s', thresholdMs: 3000 },
    { format: 'pdf', description: '100-page text PDF under 3 s', thresholdMs: 3000 },
  ];
  for (const target of targets) {
    const group = samples.filter(
      (sample) => sample.format === target.format && sample.library === 'docsluice',
    );
    const successful = group.filter((sample) => sample.status === 'ok');
    if (successful.length !== repeats) {
      const reason = group.find((sample) => sample.status !== 'ok')?.reason ?? 'no valid semantic output';
      lines.push(`- ${target.description}: **UNVERIFIED** (not measured: ${reason}).`);
    } else {
      const observed = median(successful.map((sample) => sample.durationMs));
      lines.push(
        `- ${target.description}: **${observed < target.thresholdMs ? 'MET' : 'MISS'}** (median ${formatMilliseconds(observed)}).`,
      );
    }
  }
  lines.push(
    '',
    '## Method and limits',
    '',
    'Each parse runs in a fresh isolated child process group. The parent enforces a wall-clock timeout, a combined stdout/stderr byte cap, and a sampled RSS ceiling; it kills the entire process group if a bound is exceeded or RSS monitoring fails. The worker reads the fixture, invokes the named parser to produce text or cell values, checks that each expected marker identity occurs exactly once, and reports timing only when complete semantic output is present. `peak RSS` is the maximum sampled absolute RSS of the child process group, including Node and parser startup; it is not a parser-only allocation delta and brief spikes between 25 ms samples may be missed. The default ceiling is 1024 MiB and `BENCH_MAX_RSS_MIB` can set it from 1 to 8192 MiB. The Linux `ps` monitor is required; each sample is capped at 1 MiB output and 2 seconds, and active monitor processes are aborted on child termination. Unsupported platforms and unavailable monitoring fail closed without performance results. Results are comparable only on the same machine, Node version, dependency versions, and fixture hashes.',
    '',
    `Fixture generation source: \`${fixtureManifest.generator}\`; license: ${fixtureManifest.generatorLicense}. ${fixtureManifest.source} ZIP inputs use ${fixtureManifest.zipLibrary}. Comparator versions and licenses are pinned in \`bench/comparators.json\`.`,
    '',
    'The `xlsx` row uses the public npm package version recorded in the comparator catalog. SheetJS documents its official CDN distribution separately; these are not treated as the same build. The official installation notes say the cited prototype-pollution issue was resolved in 0.19.3, that npm is stale at 0.18.5, and that current Snyk reporting is a tooling false positive. That note does not establish the security status of the benchmarked 0.18.5 npm package. `officeparser` currently returns a structured AST and the benchmark serializes it to text, so the PRD’s “mostly plain text” description should be revisited.',
    '',
    `The 5 MiB DOCX contains ${fixtureManifest.fixtures.docx.fillerCharacters.toLocaleString('en-US')} deterministic filler characters plus ${fixtureManifest.fixtures.docx.markerCharacters.toLocaleString('en-US')} marker characters; this size padding is not representative prose. Host details record the observed machine only and do not claim it matches the PRD's “2023 laptop” target. No library timings are inferred from format detection, archive inspection, or unavailable readers. This results page is a Node/server benchmark; it does not measure browser or edge-worker runtime performance.`,
    '',
    `## Limit decision`,
    '',
    'See [ADR 0013](../adr/0013-benchmark-limits.md). The current accepted base has no DOCX, XLSX, or PDF reader, so its PERF-1 targets and PERF-2 memory behavior are not yet measured. No default limit changes are justified by these comparator timings alone.',
    '',
  );
  return lines.join('\n').trimEnd();
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function ensureFixtureFiles() {
  await generateFixtures(FIXTURES);
  const manifest = JSON.parse(await readFile(resolve(FIXTURES, 'manifest.json'), 'utf8'));
  for (const fixture of Object.values(manifest.fixtures)) {
    const path = resolve(FIXTURES, fixture.file);
    await access(path);
    const hash = await sha256File(path);
    if (hash !== fixture.sha256) throw new Error(`Fixture hash mismatch for ${fixture.file}.`);
  }
  return manifest;
}

async function runOne({ benchmarkCase, fixture, library, repeat, timeoutMs, maxRssBytes, depsDirectory }) {
  const inputPath = resolve(FIXTURES, fixture.file);
  try {
    const result = await runChildProcess({
      command: process.execPath,
      args: [
        WORKER,
        library,
        benchmarkCase.format,
        inputPath,
        String(benchmarkCase.expectedUnits),
        benchmarkCase.marker,
      ],
      timeoutMs,
      maxOutputBytes: DEFAULT_OUTPUT_LIMIT_BYTES,
      maxRssBytes,
      env: {
        ...process.env,
        ...(depsDirectory ? { DOCSLUICE_BENCH_NODE_MODULES: depsDirectory } : {}),
      },
    });
    const report = JSON.parse(result.stdout);
    return {
      format: benchmarkCase.format,
      fixture: fixture.file,
      fixtureSha256: fixture.sha256,
      library,
      repeat,
      ...report,
      ...(report.status === 'ok' ? { peakRssBytes: result.peakRssBytes } : {}),
    };
  } catch (error) {
    let reason = error.code ?? 'worker-failed';
    let detail = error.message;
    if (error.stderr) {
      const lastLine = error.stderr.trim().split('\n').at(-1);
      try {
        const workerError = JSON.parse(lastLine);
        reason = workerError.code ?? reason;
        detail = workerError.error ?? detail;
      } catch {
        // Keep the bounded child error text when it is not a worker JSON record.
      }
    }
    return {
      format: benchmarkCase.format,
      fixture: fixture.file,
      fixtureSha256: fixture.sha256,
      library,
      repeat,
      status: error.code === 'BENCH_TIMEOUT' ? 'timed-out' : 'error',
      reason,
      detail,
    };
  }
}

function parsePositiveInteger(name, value, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

export async function runBench({
  repeats = parsePositiveInteger('BENCH_REPEATS', process.env.BENCH_REPEATS ?? '3', 10),
  timeoutMs = parsePositiveInteger(
    'BENCH_TIMEOUT_MS',
    process.env.BENCH_TIMEOUT_MS ?? String(DEFAULT_TIMEOUT_MS),
    600_000,
  ),
  maxRssBytes = parsePositiveInteger('BENCH_MAX_RSS_MIB', process.env.BENCH_MAX_RSS_MIB ?? '1024', 8192) *
    1024 *
    1024,
  depsDirectory = process.env.DOCSLUICE_BENCH_NODE_MODULES,
  outputPath = RESULTS,
} = {}) {
  const catalog = JSON.parse(await readFile(CATALOG, 'utf8'));
  const fixtureManifest = await ensureFixtureFiles();
  const packageJson = JSON.parse(
    await readFile(resolve(REPOSITORY, 'packages/docsluice/package.json'), 'utf8'),
  );
  catalog.libraries.docsluice.version = `workspace build (${packageJson.version})`;
  const samples = [];
  for (const benchmarkCase of catalog.cases) {
    const fixture = fixtureManifest.fixtures[benchmarkCase.format];
    if (!fixture || fixture.file !== benchmarkCase.fixture) {
      throw new Error(`Missing expected fixture registration for ${benchmarkCase.format}.`);
    }
    for (const library of benchmarkCase.libraries) {
      if (!catalog.libraries[library]) throw new Error(`Missing comparator registration for ${library}.`);
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        const sample = await runOne({
          benchmarkCase,
          fixture,
          library,
          repeat,
          timeoutMs,
          maxRssBytes,
          depsDirectory,
        });
        samples.push(sample);
        process.stdout.write(
          `${benchmarkCase.format}/${library} run ${repeat}/${repeats}: ${sample.status}${sample.durationMs === undefined ? '' : ` ${formatMilliseconds(sample.durationMs)}`}\n`,
        );
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    catalog,
    cases: catalog.cases,
    fixtureManifest,
    samples,
    repeats,
    timeoutMs,
    maxRssBytes,
    system: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${renderResults(report)}\n`);
  const unavailableDependencies = samples.filter((sample) => sample.reason === 'dependency-not-installed');
  if (unavailableDependencies.length > 0) {
    process.stderr.write(
      `Unavailable comparator dependencies: ${[...new Set(unavailableDependencies.map(({ library }) => library))].join(', ')}\n`,
    );
    process.exitCode = 1;
  }
  const failedSamples = samples.filter((sample) => sample.status !== 'ok' && sample.status !== 'unavailable');
  if (failedSamples.length > 0) {
    process.stderr.write(
      `Benchmark samples failed: ${[...new Set(failedSamples.map(({ reason }) => reason ?? 'unknown'))].join(', ')}\n`,
    );
    process.exitCode = 1;
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outputPath = process.argv[2] ? resolve(process.argv[2]) : RESULTS;
  await runBench({ outputPath });
}

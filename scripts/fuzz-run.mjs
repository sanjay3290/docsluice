#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = join(root, 'packages/docsluice');
const targetFile = join(packageRoot, 'fuzz/runner/jazzer-target.mjs');
/**
 * Fuzz targets: the compiled module and export Jazzer calls, and the seed folders copied before a run.
 * `zip` uses the strict adapter in `fuzz/runner/strict-zip.fuzz.mjs`. To add a target, add a row here
 * and its name to both workflow matrices.
 */
export const TARGETS = {
  zip: { module: 'fuzz/zip.fuzz.js', export: 'fuzzZip', seeds: ['corpus/zip', 'hostile/zip'] },
  xml: { module: 'fuzz/xml.fuzz.js', export: 'fuzzXml', seeds: ['corpus/xml', 'hostile/xml'] },
  detect: {
    module: 'fuzz/detect.fuzz.js',
    export: 'fuzzDetect',
    seeds: ['corpus/zip', 'corpus/ole', 'hostile/zip', 'hostile/ole', 'hostile/xml'],
  },
  detection: { module: 'fuzz/detection.fuzz.js', export: 'fuzzDetection', seeds: ['corpus', 'hostile/xml'] },
  ole: { module: 'fuzz/ole.fuzz.js', export: 'fuzzOle', seeds: ['corpus/ole', 'hostile/ole'] },
  txt: { module: 'fuzz/txt.fuzz.js', export: 'fuzzTxt', seeds: ['corpus/txt', 'hostile/txt'] },
  markdown: {
    module: 'fuzz/markdown.fuzz.js',
    export: 'fuzzMarkdown',
    seeds: ['corpus/markdown', 'hostile/markdown'],
  },
  csv: {
    module: 'fuzz/csv.fuzz.js',
    export: 'fuzzCsv',
    seeds: ['corpus/csv', 'corpus/tsv', 'hostile/csv', 'hostile/tsv'],
  },
  json: { module: 'fuzz/json.fuzz.js', export: 'fuzzJson', seeds: ['corpus/json', 'hostile/json'] },
  'xml-reader': {
    module: 'fuzz/xml-reader.fuzz.js',
    export: 'fuzzXmlReader',
    seeds: ['corpus/xml', 'hostile/xml'],
  },
  html: { module: 'fuzz/html.fuzz.js', export: 'fuzzHtml', seeds: ['corpus/html', 'hostile/html'] },
  doc: { module: 'fuzz/doc.fuzz.js', export: 'fuzzDoc', seeds: ['corpus/doc', 'corpus/ole', 'hostile/doc'] },
  docx: { module: 'fuzz/docx.fuzz.js', export: 'fuzzDocx', seeds: ['corpus/docx', 'hostile/docx'] },
  ooxml: {
    module: 'fuzz/ooxml.fuzz.js',
    export: 'fuzzOoxml',
    seeds: ['corpus/docx', 'corpus/xlsx', 'corpus/pptx', 'hostile/ooxml'],
  },
};
const targets = new Set(Object.keys(TARGETS));

function appendByteTail(current, chunk, limit) {
  const combined = globalThis.Buffer.concat([current, chunk]);
  return combined.byteLength <= limit
    ? combined
    : globalThis.Buffer.from(combined.subarray(combined.byteLength - limit));
}

function parseArgs(args) {
  const options = { target: undefined, seconds: 60, memoryMb: 1024, artifacts: undefined, seeds: [] };
  while (args.length) {
    const arg = args.shift();
    if (arg === '--seconds') options.seconds = Number(args.shift());
    else if (arg === '--memory-mb') options.memoryMb = Number(args.shift());
    else if (arg === '--artifacts') options.artifacts = args.shift();
    else if (arg === '--seed') options.seeds.push(args.shift());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!options.target) options.target = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return options;
}

// Licences, goldens, manifests and readmes are not inputs; every other corpus or hostile file is a seed.
const SIDECAR_NAMES = new Set(['README.md', 'manifest.json', '.gitattributes', '.gitkeep']);
const SIDECAR_SUFFIXES = ['.license', '.expected.json', '.expected.md', '.blocks.json', '.native.txt'];
function isSidecar(name) {
  return SIDECAR_NAMES.has(name) || SIDECAR_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

async function walkFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile() && !isSidecar(entry.name)) files.push(path);
  }
  return files.sort();
}

function seedDirectories(target) {
  return TARGETS[target].seeds.map((path) => join(root, path));
}

async function copySeeds(target, directory, extraSeeds = []) {
  await mkdir(directory, { recursive: true });
  let sequence = 0;
  for (const sourceDirectory of seedDirectories(target)) {
    for (const source of await walkFiles(sourceDirectory)) {
      const input = await readFile(source);
      if (!input.byteLength || input.byteLength > 20_000_000) continue;
      const name = `${String(sequence++).padStart(5, '0')}-${basename(source)}`;
      await writeFile(join(directory, name), input, { flag: 'wx' });
    }
  }
  for (const seedPath of extraSeeds) {
    const seedStat = await stat(seedPath);
    const sources = seedStat.isDirectory() ? await walkFiles(seedPath) : [seedPath];
    for (const source of sources) {
      const input = await readFile(source);
      if (!input.byteLength || input.byteLength > 20_000_000) continue;
      const name = `${String(sequence++).padStart(5, '0')}-${basename(source)}`;
      await writeFile(join(directory, name), input, { flag: 'wx' });
    }
  }
  return sequence;
}

async function currentTreeRss(rootPid, psBin = 'ps') {
  if (process.platform !== 'linux') return 0;
  let listing;
  try {
    listing = await new Promise((resolveListing, reject) => {
      const child = spawn(psBin, ['-eo', 'pid=,ppid=,rss='], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('close', (code) => (code === 0 ? resolveListing(output) : reject(new Error('ps failed'))));
    });
  } catch {
    return null;
  }
  const rows = listing
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const children = new Map();
  for (const [pid, parent, rss] of rows) {
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push([pid, rss]);
  }
  const pending = [rootPid];
  const seen = new Set();
  const rootRow = rows.find(([pid]) => pid === rootPid);
  if (!rootRow) return null;
  let totalKb = rootRow[2];
  while (pending.length) {
    const parent = pending.pop();
    if (seen.has(parent)) continue;
    seen.add(parent);
    for (const [pid, rss] of children.get(parent) ?? []) {
      totalKb += rss;
      pending.push(pid);
    }
  }
  return totalKb * 1024;
}

async function compileFuzzSources(
  buildDir,
  { tscBin = join(root, 'node_modules/.bin/tsc'), timeoutMs = 30_000, outputLimitBytes = 32 * 1024 } = {},
) {
  const sources = Object.values(TARGETS).map(({ module }) =>
    join(packageRoot, module.replace(/\.js$/, '.ts')),
  );
  const args = [
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--outDir',
    buildDir,
    '--rootDir',
    packageRoot,
    '--skipLibCheck',
    '--types',
    'node',
    '--strict',
    ...sources,
  ];
  let output = globalThis.Buffer.alloc(0);
  let outputBytes = 0;
  const child = spawn(tscBin, args, {
    cwd: root,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const capture = (chunk) => {
    outputBytes += globalThis.Buffer.byteLength(chunk);
    output = appendByteTail(output, chunk, outputLimitBytes);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  const closePromise = new Promise((resolveCompile, rejectCompile) => {
    child.once('error', rejectCompile);
    child.once('close', (code, signal) => resolveCompile({ code, signal }));
  });
  let timeout;
  let result;
  try {
    result = await Promise.race([
      closePromise,
      new Promise((resolveTimeout) => {
        timeout = globalThis.setTimeout(() => resolveTimeout(null), timeoutMs);
      }),
    ]);
  } catch (error) {
    throw new Error(`Could not start TypeScript fuzz-source compiler: ${error.message}`, { cause: error });
  } finally {
    globalThis.clearTimeout(timeout);
  }
  if (result === null) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // The compiler may already have exited while its process group is being stopped.
    }
    await Promise.race([
      closePromise.catch(() => undefined),
      new Promise((resolveClose) => globalThis.setTimeout(resolveClose, 2_000)),
    ]);
  }
  const diagnostic = `${outputBytes > outputLimitBytes ? `[truncated; ${outputBytes} bytes total, retaining last ${outputLimitBytes} bytes]\n` : ''}${output.toString('utf8')}`;
  if (result === null) {
    throw new Error(`TypeScript fuzz-source compilation timed out after ${timeoutMs} ms.\n${diagnostic}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `TypeScript fuzz-source compilation failed (exit ${result.code ?? result.signal}):\n${diagnostic}`,
    );
  }
}

export async function executeJazzer({
  target,
  seconds = 60,
  memoryMb = 1024,
  artifacts,
  seeds = [],
  jazzerBin = join(root, 'node_modules/.bin/jazzer'),
  fuzzTarget = targetFile,
  watchdogMs = (seconds + 30) * 1000,
  compilerTimeoutMs = 30_000,
  compilerOutputLimitBytes = 32 * 1024,
  tscBin = join(root, 'node_modules/.bin/tsc'),
  psBin = 'ps',
  extraEnv = {},
}) {
  if (!targets.has(target)) throw new Error(`Choose one target: ${[...targets].join(', ')}`);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error('--seconds must be a positive integer');
  if (!Number.isSafeInteger(memoryMb) || memoryMb < 128) throw new Error('--memory-mb must be at least 128');

  try {
    await stat(jazzerBin);
  } catch {
    throw new Error('Jazzer.js is missing. Install the repository dev dependencies before fuzzing.');
  }

  const resultsRoot = resolve(artifacts ?? join(tmpdir(), 'docsluice-fuzz-artifacts'));
  const cacheDir = join(root, 'node_modules/.cache');
  await mkdir(cacheDir, { recursive: true });
  const runDir = await mkdtemp(join(cacheDir, `docsluice-fuzz-${target}-`));
  const buildDir = join(runDir, 'build');
  const seedDir = join(runDir, 'seeds');
  const outputDir = join(
    resultsRoot,
    `${target}-${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`,
  );
  await mkdir(outputDir, { recursive: true });
  const seedCount = await copySeeds(target, seedDir, seeds);
  await compileFuzzSources(buildDir, {
    tscBin,
    timeoutMs: compilerTimeoutMs,
    outputLimitBytes: compilerOutputLimitBytes,
  });
  const env = {
    ...process.env,
    ...extraEnv,
    DOCSLUICE_FUZZ_TARGET: target,
    DOCSLUICE_FUZZ_MODULE: TARGETS[target].module,
    DOCSLUICE_FUZZ_EXPORT: TARGETS[target].export,
    DOCSLUICE_FUZZ_BUILD_DIR: buildDir,
  };
  const command = [
    jazzerBin,
    fuzzTarget,
    seedDir,
    '-i',
    `${buildDir}/src/`,
    '--timeout=1000',
    '--',
    `-max_total_time=${seconds}`,
    '-max_len=1000000',
    `-artifact_prefix=${outputDir}/crash-`,
  ];

  const child = spawn(command[0], command.slice(1), {
    cwd: root,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = globalThis.Buffer.alloc(0);
  let stderr = globalThis.Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const outputLimit = 512 * 1024;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += globalThis.Buffer.byteLength(chunk);
    stdout = appendByteTail(stdout, chunk, outputLimit);
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += globalThis.Buffer.byteLength(chunk);
    stderr = appendByteTail(stderr, chunk, outputLimit);
  });
  const hardTimeoutMs = watchdogMs;
  const started = Date.now();
  let reason;
  let rssBytes = process.platform === 'linux' ? 0 : null;
  const monitor = globalThis.setInterval(async () => {
    if (process.platform !== 'linux' || child.exitCode !== null || reason) return;
    const observed = await currentTreeRss(child.pid, psBin);
    if (observed === null) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      reason ??= 'memory cap monitor could not read the Linux process tree';
      rssBytes = null;
      return;
    }
    rssBytes = Math.max(rssBytes, observed);
    if (rssBytes > memoryMb * 1024 * 1024)
      reason ??= `memory cap exceeded (${Math.ceil(rssBytes / 1024 / 1024)} MiB > ${memoryMb} MiB)`;
  }, 500);
  monitor.unref();

  let timeout;
  let memoryCheck;
  const closePromise = new Promise((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });
  let result;
  try {
    result = await Promise.race([
      closePromise,
      new Promise((resolveTimeout) => {
        timeout = globalThis.setTimeout(() => {
          reason ??= `watchdog timed out after ${hardTimeoutMs} ms`;
          resolveTimeout(null);
        }, hardTimeoutMs);
      }),
      new Promise((resolveMemory) => {
        memoryCheck = globalThis.setInterval(() => {
          if (reason?.startsWith('memory cap')) resolveMemory(null);
        }, 100);
        memoryCheck.unref();
      }),
    ]);
  } catch (error) {
    reason ??= `could not start Jazzer.js: ${error.message}`;
    result = { code: null, signal: null };
  }
  globalThis.clearTimeout(timeout);
  globalThis.clearInterval(monitor);
  globalThis.clearInterval(memoryCheck);
  if (reason) {
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // The fuzzer may already have exited while its process group is being stopped.
    }
    result = await Promise.race([
      closePromise.catch(() => ({ code: null, signal: 'SIGKILL' })),
      new Promise((resolveClosed) =>
        globalThis.setTimeout(() => resolveClosed({ code: null, signal: 'SIGKILL' }), 2_000),
      ),
    ]);
  }
  await writeFile(
    join(outputDir, 'stdout.log'),
    globalThis.Buffer.concat([
      globalThis.Buffer.from(
        stdoutBytes > outputLimit
          ? `[truncated; ${stdoutBytes} bytes total, retaining last ${outputLimit} bytes]\n`
          : '',
      ),
      stdout,
    ]),
  );
  await writeFile(
    join(outputDir, 'stderr.log'),
    globalThis.Buffer.concat([
      globalThis.Buffer.from(
        stderrBytes > outputLimit
          ? `[truncated; ${stderrBytes} bytes total, retaining last ${outputLimit} bytes]\n`
          : '',
      ),
      stderr,
    ]),
  );
  await writeFile(
    join(outputDir, 'run.json'),
    JSON.stringify(
      {
        target,
        seedCount,
        seconds,
        memoryCapMiB: memoryMb,
        memoryMonitoring:
          process.platform !== 'linux'
            ? 'unsupported-non-linux'
            : rssBytes === null
              ? 'failed'
              : 'linux-rss-process-tree',
        peakProcessTreeMiB: rssBytes === null ? null : Math.ceil(rssBytes / 1024 / 1024),
        elapsedMs: Date.now() - started,
        exitCode: result.code,
        signal: result.signal,
        failure: reason ?? (result.code === 0 ? null : 'Jazzer.js reported a crash or failed run'),
        command: command.slice(1),
      },
      null,
      2,
    ),
  );
  if (reason || result.code !== 0) {
    const error = new Error(reason ?? `Jazzer.js exited with ${result.code ?? result.signal}`);
    error.artifactDir = outputDir;
    error.exitCode = result.code ?? 1;
    throw error;
  }
  await rm(runDir, { recursive: true, force: true });
  return { target, seedCount, elapsedMs: Date.now() - started, artifactDir: outputDir };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      `Usage: node scripts/fuzz-run.mjs <${[...targets].join('|')}> [--seconds N] [--memory-mb N] [--artifacts DIR] [--seed FILE_OR_DIR]\n`,
    );
    return;
  }
  const result = await executeJazzer(options);
  process.stdout.write(
    `Fuzzed ${result.target} for ${Math.round(result.elapsedMs / 1000)}s with ${result.seedCount} seeds. Artifacts: ${result.artifactDir}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `Fuzz run failed: ${error.message}${error.artifactDir ? ` (artifacts: ${error.artifactDir})` : ''}\n`,
    );
    process.exitCode = error.exitCode ?? 1;
  });
}

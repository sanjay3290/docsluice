import { lstat, readdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath, URL } from 'node:url';
import { basename, relative, resolve, sep } from 'node:path';
import { readTruthFile } from './truth.mjs';
import { scoreDocument } from './score.mjs';

export const TARGET_FORMATS = ['docx', 'xlsx', 'pptx', 'pdf'];
export const SUPPLEMENTAL_FORMATS = ['doc'];
export const MINIMUM_RECALL = 0.98;
const MAX_TRUTH_FILES = 1_000;
const MAX_TRUTH_TREE_ENTRIES = 10_000;
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function sumMetric(files, key) {
  let correct = 0;
  let total = 0;
  for (const file of files) {
    const metric = file.metrics?.[key];
    if (!metric) continue;
    correct += metric.correct;
    total += metric.total;
  }
  return { correct, total, score: total === 0 ? null : correct / total };
}

export function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export async function mapSequential(values, callback) {
  const results = [];
  for (let index = 0; index < values.length; index++) {
    results.push(await callback(values[index], index));
  }
  return results;
}

export function resolveQualityGate(summaries, truthErrors = []) {
  const thresholds = summaries.filter((summary) => summary.threshold.required);
  const failed =
    truthErrors.length > 0 || thresholds.some((summary) => summary.threshold.status === 'failed');
  const incomplete = thresholds.some((summary) => summary.threshold.status.startsWith('blocked-'));
  return {
    gate: failed ? 'failed' : incomplete ? 'not-ready' : 'passed',
    exitCode: failed ? 1 : incomplete ? 2 : 0,
  };
}

export function summarizeFormat(format, files) {
  const isTarget = TARGET_FORMATS.includes(format);
  const availability =
    files.length === 0
      ? 'missing-truth'
      : (files.find((file) => file.status !== 'scored')?.status ?? 'available');
  const reviewStatus =
    files.length === 0
      ? null
      : files.every((file) => file.reviewStatus === 'reviewed')
        ? 'reviewed'
        : 'pending';
  const metrics = {
    wordRecall: sumMetric(files, 'wordRecall'),
    tableCellAccuracy: sumMetric(files, 'tableCellAccuracy'),
    readingOrderAccuracy: sumMetric(files, 'readingOrderAccuracy'),
  };
  let thresholdStatus = 'not-applicable';
  if (isTarget) {
    if (availability !== 'available') thresholdStatus = `blocked-${availability}`;
    else if (reviewStatus !== 'reviewed') thresholdStatus = 'blocked-unreviewed';
    else if (metrics.wordRecall.score === null) thresholdStatus = 'blocked-no-word-recall';
    else thresholdStatus = metrics.wordRecall.score >= MINIMUM_RECALL ? 'passed' : 'failed';
  }
  return {
    format,
    availability,
    reviewStatus,
    metrics,
    threshold: {
      required: isTarget,
      minimumWordRecall: isTarget ? MINIMUM_RECALL : null,
      status: thresholdStatus,
    },
    files,
  };
}

async function listTruthFiles(root) {
  const truthRoot = resolve(root, 'corpus/package-a-truth');
  let rootStat;
  try {
    rootStat = await lstat(truthRoot);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new TypeError('Quality truth directory must be a regular directory.');
  }

  const paths = [];
  const pending = [truthRoot];
  let visitedEntries = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const entry of entries) {
      if (++visitedEntries > MAX_TRUTH_TREE_ENTRIES)
        throw new RangeError('Quality truth tree exceeds the entry bound.');
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError('Quality truth tree cannot contain symbolic links.');
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name.endsWith('.truth.md')) {
        paths.push(path);
        if (paths.length > MAX_TRUTH_FILES)
          throw new RangeError('Quality truth file count exceeds the bound.');
      }
    }
  }
  return paths.sort((left, right) => compareCodeUnits(relative(truthRoot, left), relative(truthRoot, right)));
}

async function loadExtractor(root) {
  const entry = resolve(root, 'packages/docsluice/dist/index.js');
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.extract !== 'function')
    throw new TypeError('Built docsluice package does not export extract().');
  return module.extract;
}

function extractionStatus(error) {
  return error?.code === 'UNSUPPORTED_FORMAT' ? 'missing-reader' : 'extraction-failed';
}

async function scoreTruthFile(truthPath, root, extract) {
  const relativeTruth = relative(root, truthPath).split(sep).join('/');
  try {
    const loaded = await readTruthFile(truthPath, root);
    let document;
    try {
      document = await extract(loaded.sourceBytes, { filename: basename(loaded.sourcePath) });
    } catch (error) {
      return {
        file: relativeTruth,
        source: loaded.truth.source,
        format: loaded.truth.format,
        reviewStatus: loaded.truth.reviewStatus,
        status: extractionStatus(error),
      };
    }
    if (document.format !== loaded.truth.format) {
      return {
        file: relativeTruth,
        source: loaded.truth.source,
        format: loaded.truth.format,
        reviewStatus: loaded.truth.reviewStatus,
        status: 'format-mismatch',
        actualFormat: document.format,
      };
    }
    if (loaded.truth.format === 'pdf' && document.stats.needsOcr) {
      return {
        file: relativeTruth,
        source: loaded.truth.source,
        format: loaded.truth.format,
        reviewStatus: loaded.truth.reviewStatus,
        status: 'needs-ocr',
      };
    }
    return {
      file: relativeTruth,
      source: loaded.truth.source,
      format: loaded.truth.format,
      reviewStatus: loaded.truth.reviewStatus,
      status: 'scored',
      metrics: scoreDocument(loaded.truth, document),
    };
  } catch (error) {
    return {
      file: relativeTruth,
      status: 'invalid-truth',
      error: error instanceof Error ? error.message : 'Truth validation failed.',
    };
  }
}

export async function runQuality({ root = ROOT } = {}) {
  const repositoryRoot = resolve(root);
  const extract = await loadExtractor(repositoryRoot);
  const truthPaths = await listTruthFiles(repositoryRoot);
  const fileResults = await mapSequential(truthPaths, (path) =>
    scoreTruthFile(path, repositoryRoot, extract),
  );
  const formats = new Set([
    ...TARGET_FORMATS,
    ...SUPPLEMENTAL_FORMATS,
    ...fileResults.flatMap((file) => (file.format ? [file.format] : [])),
  ]);
  const summaries = [...formats].sort().map((format) =>
    summarizeFormat(
      format,
      fileResults.filter((file) => file.format === format),
    ),
  );
  const truthErrors = fileResults.filter((file) => file.status === 'invalid-truth');
  const gate = resolveQualityGate(summaries, truthErrors);
  return {
    schema: 'docsluice-quality-report-v1',
    minimumWordRecall: MINIMUM_RECALL,
    gate: gate.gate,
    formats: summaries,
    truthErrors,
    exitCode: gate.exitCode,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await runQuality();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.exitCode;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Quality scoring failed.'}\n`);
    process.exitCode = 1;
  }
}

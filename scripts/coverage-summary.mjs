import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const coveragePath = 'packages/docsluice/coverage/coverage-summary.json';

function readCoverageSummary(path = coveragePath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Coverage summary at ${path} is not valid JSON.`, { cause: error });
    }
    if (error.code === 'ENOENT') {
      throw new Error(`Coverage summary is missing at ${path}; run the coverage command first.`, {
        cause: error,
      });
    }
    throw error;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.total || !parsed.total.lines) {
    throw new Error(`Coverage summary at ${path} has no total line coverage.`);
  }
  return parsed;
}

function lineCounts(entry, label) {
  const lines = entry?.lines;
  if (
    !lines ||
    !Number.isSafeInteger(lines.total) ||
    !Number.isSafeInteger(lines.covered) ||
    lines.total < 0 ||
    lines.covered < 0 ||
    lines.covered > lines.total
  ) {
    throw new Error(`Coverage summary has invalid line counts for ${label}.`);
  }
  return { total: lines.total, covered: lines.covered };
}

function addCounts(target, counts) {
  target.total += counts.total;
  target.covered += counts.covered;
}

function percentage({ total, covered }) {
  return total === 0 ? null : (covered / total) * 100;
}

function summarizeCoverage(summary) {
  const overall = lineCounts(summary?.total, 'total');
  const groups = {
    budget: { covered: 0, total: 0 },
    zip: { covered: 0, total: 0 },
    xml: { covered: 0, total: 0 },
    readers: { covered: 0, total: 0 },
    other: { covered: 0, total: 0 },
  };

  for (const [file, entry] of Object.entries(summary)) {
    if (file === 'total') continue;
    const counts = lineCounts(entry, file);
    const sourcePath = file.replaceAll('\\', '/');
    let group = 'other';
    if (/\/src\/core\/budget\.ts$/.test(sourcePath)) group = 'budget';
    else if (/\/src\/zip\//.test(sourcePath)) group = 'zip';
    else if (/\/src\/xml\//.test(sourcePath)) group = 'xml';
    else if (/\/src\/readers\//.test(sourcePath)) group = 'readers';
    addCounts(groups[group], counts);
  }

  return {
    overall: { ...overall, pct: percentage(overall) },
    budget: { ...groups.budget, pct: percentage(groups.budget) },
    zip: { ...groups.zip, pct: percentage(groups.zip) },
    xml: { ...groups.xml, pct: percentage(groups.xml) },
    readers: { ...groups.readers, pct: percentage(groups.readers) },
    other: { ...groups.other, pct: percentage(groups.other) },
  };
}

function formatCoverageSummary(result) {
  const rows = [
    ['Overall', result.overall],
    ['Budget', result.budget],
    ['ZIP', result.zip],
    ['XML', result.xml],
    ['Readers', result.readers],
    ['Other source', result.other],
  ];
  const lines = [
    '### Line coverage',
    '',
    '| Scope | Line coverage | Covered / total lines |',
    '| --- | ---: | ---: |',
  ];
  for (const [label, counts] of rows) {
    const pct = counts.pct === null ? 'n/a' : `${Number(counts.pct.toFixed(2))}%`;
    lines.push(`| ${label} | ${pct} | ${counts.covered}/${counts.total} |`);
  }
  lines.push('', 'Thresholds: budget, ZIP, XML 100%; readers 90% per file; all source 85% per file.', '');
  return lines.join('\n');
}

function main() {
  const report = formatCoverageSummary(summarizeCoverage(readCoverageSummary()));
  const destination = process.env.GITHUB_STEP_SUMMARY;
  if (destination) appendFileSync(destination, `${report}\n`);
  else process.stdout.write(`${report}\n`);
}

export { formatCoverageSummary, readCoverageSummary, summarizeCoverage };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Coverage summary failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

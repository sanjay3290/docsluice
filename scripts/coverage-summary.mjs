// Write the line-coverage summary (QA-5) as Markdown: to the GitHub job summary when
// GITHUB_STEP_SUMMARY is set, else to stdout. Usage: node scripts/coverage-summary.mjs [summary.json]
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';

/** The per-file line threshold docs/testing.md and vitest.config.ts set for a source path. */
export function threshold(path) {
  if (path === 'src/core/budget.ts' || path.startsWith('src/zip/') || path.startsWith('src/xml/')) return 100;
  if (path.startsWith('src/readers/')) return 90;
  return 85;
}

/** Markdown for a Vitest `json-summary` report: totals, groups and the files closest to their bar. */
export function summarize(report) {
  const files = Object.entries(report)
    .filter(([path]) => path !== 'total')
    .map(([path, data]) => {
      const relative = path.slice(path.indexOf('src/'));
      return { path: relative, lines: data.lines.pct, bar: threshold(relative) };
    });
  const failing = files.filter((file) => file.lines < file.bar);
  const groups = [
    ['Budget, ZIP, XML', (path) => threshold(path) === 100],
    ['Readers', (path) => path.startsWith('src/readers/')],
    ['Everything else', (path) => threshold(path) === 85],
  ];
  const lines = [
    '## Line coverage (QA-5)',
    '',
    `Total: **${report.total.lines.pct}%** of ${report.total.lines.total} lines. ${
      failing.length === 0
        ? 'Every file meets its threshold.'
        : `**${failing.length} file(s) below threshold.**`
    }`,
    '',
    '| Group | Files | Lowest file | Threshold |',
    '| --- | --- | --- | --- |',
  ];
  for (const [name, match] of groups) {
    const members = files.filter((file) => match(file.path));
    if (members.length === 0) continue;
    const lowest = members.reduce((low, file) => (file.lines < low.lines ? file : low));
    lines.push(`| ${name} | ${members.length} | \`${lowest.path}\` ${lowest.lines}% | ${lowest.bar}% |`);
  }
  const closest = [...files].sort(
    (a, b) => a.lines - a.bar - (b.lines - b.bar) || a.path.localeCompare(b.path),
  );
  lines.push('', '<details><summary>Ten files closest to their threshold</summary>', '');
  lines.push('| File | Lines | Threshold |', '| --- | --- | --- |');
  for (const file of closest.slice(0, 10)) lines.push(`| \`${file.path}\` | ${file.lines}% | ${file.bar}% |`);
  lines.push('', '</details>', '');
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path =
    process.argv[2] ??
    fileURLToPath(new URL('../packages/docsluice/coverage/coverage-summary.json', import.meta.url));
  const markdown = summarize(JSON.parse(readFileSync(path, 'utf8')));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  else console.log(markdown);
}

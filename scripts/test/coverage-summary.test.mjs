import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCoverageSummary, readCoverageSummary, summarizeCoverage } from '../coverage-summary.mjs';

const coverage = {
  total: { lines: { total: 100, covered: 90, skipped: 0, pct: 90 } },
  '/repo/packages/docsluice/src/core/budget.ts': { lines: { total: 10, covered: 10, skipped: 0, pct: 100 } },
  '/repo/packages/docsluice/src/zip/index.ts': { lines: { total: 20, covered: 18, skipped: 0, pct: 90 } },
  '/repo/packages/docsluice/src/xml/tokenizer.ts': { lines: { total: 30, covered: 27, skipped: 0, pct: 90 } },
  '/repo/packages/docsluice/src/readers/text/index.ts': {
    lines: { total: 40, covered: 35, skipped: 0, pct: 87.5 },
  },
};

test('summarizes overall and scoped coverage by covered and total lines', () => {
  const result = summarizeCoverage(coverage);
  assert.equal(result.overall.pct, 90);
  assert.equal(result.budget.pct, 100);
  assert.equal(result.zip.pct, 90);
  assert.equal(result.xml.pct, 90);
  assert.equal(result.readers.pct, 87.5);
});

test('formats a meaningful markdown table with empty groups called out', () => {
  const markdown = formatCoverageSummary(
    summarizeCoverage({
      total: { lines: { total: 2, covered: 2, skipped: 0, pct: 100 } },
      '/repo/packages/docsluice/src/index.ts': { lines: { total: 2, covered: 2, skipped: 0, pct: 100 } },
    }),
  );
  assert.match(markdown, /\| Overall \| 100% \| 2\/2 \|/);
  assert.match(markdown, /\| Readers \| n\/a \| 0\/0 \|/);
  assert.match(markdown, /\| Other source \| 100% \| 2\/2 \|/);
});

test('fails clearly when the coverage artifact is missing', () => {
  assert.throws(
    () => readCoverageSummary('/tmp/docsluice-coverage-summary-that-does-not-exist.json'),
    /Coverage summary is missing.*run the coverage command first/,
  );
});

test('rejects summaries that omit source line totals', () => {
  assert.throws(() => summarizeCoverage({ total: { lines: { pct: 0 } } }), /invalid line counts/);
});

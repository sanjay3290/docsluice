import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarize, threshold } from '../coverage-summary.mjs';

const entry = (pct, total = 100) => ({ lines: { pct, total, covered: Math.round((pct * total) / 100) } });

test('thresholds follow docs/testing.md', () => {
  assert.equal(threshold('src/core/budget.ts'), 100);
  assert.equal(threshold('src/zip/index.ts'), 100);
  assert.equal(threshold('src/xml/tokenizer.ts'), 100);
  assert.equal(threshold('src/readers/csv/index.ts'), 90);
  assert.equal(threshold('src/core/builder.ts'), 85);
});

test('the summary names totals, groups, failures and the closest files', () => {
  const markdown = summarize({
    total: entry(95.5, 1000),
    '/repo/packages/docsluice/src/zip/index.ts': entry(100),
    '/repo/packages/docsluice/src/readers/csv/index.ts': entry(88),
    '/repo/packages/docsluice/src/core/builder.ts': entry(97),
  });
  assert.match(markdown, /Total: \*\*95\.5%\*\* of 1000 lines\. \*\*1 file\(s\) below threshold\.\*\*/);
  assert.match(markdown, /\| Readers \| 1 \| `src\/readers\/csv\/index\.ts` 88% \| 90% \|/);
  assert.match(markdown, /\| Budget, ZIP, XML \| 1 \|/);
  assert.ok(
    markdown.indexOf('src/readers/csv/index.ts` | 88%') < markdown.indexOf('src/core/builder.ts` | 97%'),
  );
  assert.match(
    summarize({ total: entry(100, 10), '/x/src/xml/a.ts': entry(100) }),
    /Every file meets its threshold\./,
  );
});

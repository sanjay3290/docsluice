import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const reviewUrl = new globalThis.URL('../../docs/security/review-1.0.md', import.meta.url);
const auditUrl = new globalThis.URL(
  '../../docs/security/evidence/npm-audit-all-2026-10-09.json',
  import.meta.url,
);

test('security review remains explicitly incomplete and maps SEC-1 through SEC-14', async () => {
  const review = await readFile(reviewUrl, 'utf8');
  assert.match(review, /Readiness: INCOMPLETE — NOT READY FOR 1\.0/);
  assert.match(review, /seven consecutive nightly runs/);
  assert.match(review, /reader coverage, integration, multi-night fuzzing, and hosted CI remain unverified/);
  for (let requirement = 1; requirement <= 14; requirement += 1) {
    assert.match(review, new RegExp(`\\| SEC-${requirement} —`));
  }
});

test('recorded npm audit evidence agrees with the review disposition', async () => {
  const [review, auditText] = await Promise.all([readFile(reviewUrl, 'utf8'), readFile(auditUrl, 'utf8')]);
  const audit = JSON.parse(auditText);
  assert.deepEqual(audit.metadata.vulnerabilities, {
    info: 0,
    low: 0,
    moderate: 1,
    high: 0,
    critical: 0,
    total: 1,
  });
  assert.equal(audit.vulnerabilities.fflate.severity, 'moderate');
  assert.match(JSON.stringify(audit.vulnerabilities.fflate.via), /GHSA-px8p-9vwx-vf98/);
  assert.match(review, /SEC14-1 \| \*\*Moderate — open\*\*/);
  assert.match(
    review,
    /npm audit snapshot reported zero high and zero critical advisories, one moderate advisory/,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import {
  compareCodeUnits,
  mapSequential,
  resolveQualityGate,
  runQuality,
  summarizeFormat,
  TARGET_FORMATS,
} from '../quality/run.mjs';

const wordScore = (correct, total) => ({ correct, total, score: total === 0 ? null : correct / total });

test('a perfect pending truth remains blocked from the quality threshold', () => {
  const summary = summarizeFormat('docx', [
    {
      format: 'docx',
      status: 'scored',
      reviewStatus: 'pending',
      metrics: {
        wordRecall: wordScore(100, 100),
        tableCellAccuracy: wordScore(2, 2),
        readingOrderAccuracy: wordScore(4, 4),
      },
    },
  ]);

  assert.equal(summary.availability, 'available');
  assert.equal(summary.threshold.status, 'blocked-unreviewed');
});

test('only reviewed truth at or above 98 percent passes, and a lower score fails', () => {
  const passed = summarizeFormat('pdf', [
    {
      format: 'pdf',
      status: 'scored',
      reviewStatus: 'reviewed',
      metrics: {
        wordRecall: wordScore(98, 100),
        tableCellAccuracy: wordScore(0, 0),
        readingOrderAccuracy: wordScore(0, 0),
      },
    },
  ]);
  const failed = summarizeFormat('pdf', [
    {
      format: 'pdf',
      status: 'scored',
      reviewStatus: 'reviewed',
      metrics: {
        wordRecall: wordScore(97, 100),
        tableCellAccuracy: wordScore(0, 0),
        readingOrderAccuracy: wordScore(0, 0),
      },
    },
  ]);

  assert.equal(passed.threshold.status, 'passed');
  assert.equal(failed.threshold.status, 'failed');
});

test('missing truth and missing readers produce blocked statuses and n/a scores', () => {
  const missingTruth = summarizeFormat('xlsx', []);
  const missingReader = summarizeFormat('pptx', [
    {
      format: 'pptx',
      status: 'missing-reader',
      reviewStatus: 'reviewed',
    },
  ]);

  assert.equal(missingTruth.availability, 'missing-truth');
  assert.equal(missingTruth.metrics.wordRecall.score, null);
  assert.equal(missingTruth.threshold.status, 'blocked-missing-truth');
  assert.equal(missingReader.availability, 'missing-reader');
  assert.equal(missingReader.threshold.status, 'blocked-missing-reader');
});

test('truth scoring processes files sequentially to bound concurrent extraction memory', async () => {
  let active = 0;
  let maximum = 0;
  const results = await mapSequential([1, 2, 3], async (value) => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(1);
    active--;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6]);
  assert.equal(maximum, 1);
});

test('invalid truth forces gate status failed even when every target passed', () => {
  const allPassed = TARGET_FORMATS.map((format) => ({
    format,
    threshold: { required: true, status: 'passed' },
  }));

  assert.deepEqual(resolveQualityGate(allPassed, [{ file: 'bad.truth.md', status: 'invalid-truth' }]), {
    gate: 'failed',
    exitCode: 1,
  });
});

test('path ordering uses locale-independent code-unit comparison', () => {
  assert.equal(compareCodeUnits('A.truth.md', 'a.truth.md'), -1);
  assert.equal(compareCodeUnits('b.truth.md', 'a.truth.md'), 1);
  assert.equal(compareCodeUnits('same', 'same'), 0);
});

test('the runner scores built public extraction and reports pending and unavailable formats', async () => {
  const report = await runQuality();
  const formats = new Map(report.formats.map((summary) => [summary.format, summary]));

  assert.equal(report.schema, 'docsluice-quality-report-v1');
  assert.equal(report.minimumWordRecall, 0.98);
  assert.equal(report.exitCode, 2);
  assert.equal(report.gate, 'not-ready');
  assert.equal(formats.get('doc')?.availability, 'available');
  assert.equal(formats.get('doc')?.reviewStatus, 'pending');
  assert.equal(formats.get('doc')?.threshold.status, 'not-applicable');
  assert.equal(formats.get('docx')?.availability, 'missing-reader');
  assert.equal(formats.get('docx')?.threshold.status, 'blocked-missing-reader');
  for (const format of ['xlsx', 'pptx', 'pdf']) {
    assert.equal(formats.get(format)?.availability, 'missing-truth');
    assert.equal(formats.get(format)?.threshold.status, 'blocked-missing-truth');
  }
  assert.equal(JSON.stringify(report).includes('Legacy Word fixture'), false);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { semanticResult, validateMarkers } from '../../bench/markers.mjs';

const options = {
  markerPattern: '(?<![A-Za-z0-9])P[0-9]{5}(?![A-Za-z0-9])',
  markerPrefix: 'P',
  markerWidth: 5,
  expectedUnits: 3,
};

test('semantic marker validation requires every expected identity exactly once', () => {
  assert.deepEqual(validateMarkers('P00001 P00002 P00003', options), {
    valid: true,
    matches: 3,
    unique: 3,
    duplicate: false,
    unexpected: false,
    missing: false,
  });
});

test('a duplicate plus a missing identity is invalid even when total count is correct', () => {
  const report = validateMarkers('P00001 P00001 P00003', options);
  assert.equal(report.matches, options.expectedUnits);
  assert.equal(report.valid, false);
  assert.equal(report.duplicate, true);
  assert.equal(report.missing, true);
  const semantic = semanticResult({
    text: 'P00001 P00001 P00003',
    units: 3,
    durationMs: 12,
    markerOptions: options,
  });
  assert.equal(semantic.status, 'invalid-output');
  assert.equal('durationMs' in semantic, false);
  assert.equal(semantic.reason, 'semantic-output-marker-identity-mismatch');
});

test('unexpected identities and malformed-width identities cannot pass validation', () => {
  assert.equal(validateMarkers('P00001 P00002 P00004', options).unexpected, true);
  assert.equal(validateMarkers('P00001 P00002 P0003', options).valid, false);
  assert.equal(validateMarkers('P00001X P00002 P00003', options).valid, false);
});

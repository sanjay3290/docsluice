import { DocsluiceError } from '../src/core/errors.js';
import { formatNumber } from '../src/readers/xlsx/numfmt.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';

/** Fuzz harness entry point: interpret arbitrary bytes as a bounded format code. */
export function fuzzXlsxNumberFormat(input: Uint8Array): void {
  const formatCode = new TextDecoder().decode(input.subarray(0, 2_048));
  const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 1000 });
  try {
    formatNumber(123_456.789, formatCode, false, budget);
    formatNumber(-0.125, formatCode, true, budget);
    formatNumber(45_000.999_999, formatCode, false, budget);
    formatNumber('prototype-safe text', formatCode, false, budget);
  } catch (error) {
    // Resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

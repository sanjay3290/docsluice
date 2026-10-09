import { AbortError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseChart } from '../src/readers/pptx/charts.js';
import { parseXml } from '../src/xml/index.js';

/** Bounded entry point for arbitrary XML chart parts. */
export function fuzzPptxCharts(input: Uint8Array): void {
  if (input.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, cells: 10_000, outputChars: 65_536, xmlDepth: 64, timeMs: 1_000 },
    { warnings, onLimit: 'throw' },
  );
  try {
    const root = parseXml(input, { budget, warnings });
    if (root) parseChart(root, budget);
  } catch (error) {
    if (error instanceof AbortError || error instanceof LimitExceededError || error instanceof TimeoutError)
      return;
    throw error;
  }
}

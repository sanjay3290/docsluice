import { Budget } from '../src/core/budget.js';
import { DocsluiceError } from '../src/core/errors.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseLatex } from '../src/readers/latex/parse.js';

/** The LaTeX scanner on arbitrary text, with a small depth and output allowance. */
export function fuzzLatex(input: Uint8Array): void {
  const text = new TextDecoder().decode(input.subarray(0, 256 * 1024));
  const budget = new Budget(
    { ...DEFAULT_LIMITS, blockDepth: 32, outputChars: 65_536, timeMs: 1_000 },
    { warnings: new WarningSink() },
  );
  try {
    parseLatex(text, budget);
  } catch (error) {
    // Resource limits are ordinary outcomes; anything else is a finding.
    if (!(error instanceof DocsluiceError)) throw error;
  }
}

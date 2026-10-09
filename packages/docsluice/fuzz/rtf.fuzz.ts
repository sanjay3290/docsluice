import { AbortError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { DocBuilder } from '../src/core/builder.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import rtfReader from '../src/readers/rtf/index.js';

/** Bounded byte-oriented harness for arbitrary RTF and malformed control sequences. */
export async function fuzzRtf(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits({ blockDepth: 64, outputChars: 65_536, timeMs: 1_000 }), {
    warnings,
  });
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder('rtf', 'application/rtf', budget, options);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  try {
    await rtfReader.read(ctx);
    out.finish();
  } catch (error) {
    if (error instanceof LimitExceededError || error instanceof TimeoutError || error instanceof AbortError)
      return;
    throw error;
  }
}

import { AbortError, CorruptFileError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { DocBuilder } from '../src/core/builder.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import msgReader from '../src/readers/msg/index.js';

/** Bounded entry point for arbitrary compound files and hostile MSG properties. */
export async function fuzzMsg(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    resolveLimits({
      totalUncompressedBytes: 1_000_000,
      zipEntries: 10_000,
      outputChars: 65_536,
      timeMs: 1_000,
    }),
    { warnings },
  );
  const options = { limits: budget.limits, metadata: true, runs: false } as ResolvedOptions;
  const out = new DocBuilder('msg', 'application/vnd.ms-outlook', budget, options);
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
    await msgReader.read(ctx);
    out.finish();
  } catch (error) {
    if (
      error instanceof CorruptFileError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError ||
      error instanceof AbortError
    )
      return;
    throw error;
  }
}

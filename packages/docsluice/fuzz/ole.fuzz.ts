import { AbortError, CorruptFileError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { openCfb } from '../src/ole/index.js';

/** Bounded entry point for coverage-guided fuzzers; malformed input must not escape as an unexpected error. */
export function fuzzOle(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  const budget = new Budget(resolveLimits({ totalUncompressedBytes: 1_000_000, timeMs: 1_000 }));
  try {
    const archive = openCfb(sample, budget);
    for (const entry of archive.entries) {
      budget.tick();
      if (entry.type === 'stream') archive.read(entry.path);
    }
  } catch (error) {
    if (
      error instanceof CorruptFileError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError ||
      error instanceof AbortError
    ) {
      return;
    }
    throw error;
  }
}

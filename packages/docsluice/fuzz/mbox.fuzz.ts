import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { splitMbox } from '../src/readers/mbox/index.js';

/** Fuzz mbox envelope splitting and mboxrd unescaping. */
export function fuzzMbox(input: Uint8Array): void {
  splitMbox(
    input.subarray(0, 256 * 1024),
    new Budget({ ...DEFAULT_LIMITS, inputBytes: 256 * 1024, timeMs: 1000 }),
  );
}

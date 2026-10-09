import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  TimeoutError,
  UnsupportedFormatError,
} from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { iterateBiffRecords } from '../src/readers/xls/records.js';
import { readBiff8Sst } from '../src/readers/xls/sst.js';

const SST = 0x00fc;
const CONTINUE = 0x003c;

/** Fuzz entry point for BIFF record framing and SST continuation parsing. */
export function fuzzBiffRecords(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  const budget = new Budget(resolveLimits({ timeMs: 1_000 }));
  try {
    const records = [...iterateBiffRecords(sample, budget)];
    for (let index = 0; index < records.length; index += 1) {
      budget.tick();
      if (records[index]!.id !== SST) continue;
      const continuations: Uint8Array[] = [];
      for (let next = index + 1; records[next]?.id === CONTINUE; next += 1) {
        budget.tick();
        continuations.push(records[next]!.data);
      }
      readBiff8Sst(records[index]!.data, continuations, budget);
    }
  } catch (error) {
    if (isExpectedFuzzError(error)) return;
    throw error;
  }

  try {
    readBiff8Sst(sample, [], budget);
  } catch (error) {
    if (!isExpectedFuzzError(error)) throw error;
  }
}

function isExpectedFuzzError(error: unknown): boolean {
  return (
    error instanceof AbortError ||
    error instanceof CorruptFileError ||
    error instanceof EncryptedError ||
    error instanceof LimitExceededError ||
    error instanceof TimeoutError ||
    error instanceof UnsupportedFormatError
  );
}

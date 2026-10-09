import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  TimeoutError,
} from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { DocBuilder } from '../src/core/builder.js';
import { WarningSink } from '../src/core/warnings.js';
import { docReader } from '../src/readers/doc/index.js';
import type { ReadContext } from '../src/core/reader.js';

/** Run the legacy Word reader adapter on mutated CFB containers without unbounded work. */
export async function fuzzDoc(input: Uint8Array): Promise<void> {
  const sample = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    resolveLimits({ totalUncompressedBytes: 1_000_000, outputChars: 65_536, timeMs: 1_000 }),
    { warnings },
  );
  try {
    const ctx: ReadContext = {
      bytes: sample,
      options: {
        limits: budget.limits,
        onLimit: 'truncate',
        strict: false,
        metadata: true,
        imageGps: false,
        children: 'extract',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
        formulas: false,
      },
      budget,
      warnings,
      out: new DocBuilder('doc', 'application/msword', budget),
      path: '',
      extractChild: async () => {},
    };
    await docReader.read(ctx);
  } catch (error) {
    if (
      error instanceof AbortError ||
      error instanceof CorruptFileError ||
      error instanceof EncryptedError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError
    ) {
      return;
    }
    throw error;
  }
}

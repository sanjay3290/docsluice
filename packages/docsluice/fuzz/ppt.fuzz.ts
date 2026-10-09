import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  TimeoutError,
} from '../src/core/errors.js';
import { resolveLimits } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { pptReader } from '../src/readers/ppt/index.js';

/** Bounded legacy PPT target; unexpected exceptions remain visible to the fuzz runner. */
export async function fuzzPpt(input: Uint8Array): Promise<void> {
  const sample = input.subarray(0, 1_000_000);
  const options: ResolvedOptions = {
    limits: resolveLimits({
      inputBytes: 1_000_000,
      totalUncompressedBytes: 1_000_000,
      outputChars: 100_000,
      zipEntries: 1_000,
      blockDepth: 32,
      timeMs: 1_000,
    }),
    onLimit: 'throw',
    strict: false,
    metadata: false,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const budget = new Budget(options.limits, { onLimit: options.onLimit });
  const out = new DocBuilder('ppt', 'application/vnd.ms-powerpoint', budget, options);
  try {
    budget.addInputBytes(sample.length);
    await pptReader.read({
      bytes: sample,
      options,
      budget,
      warnings: budget.warnings,
      out,
      path: '',
      extractChild: async () => {},
    });
    out.finish();
  } catch (error) {
    if (
      error instanceof CorruptFileError ||
      error instanceof EncryptedError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError ||
      error instanceof AbortError
    )
      return;
    throw error;
  }
}

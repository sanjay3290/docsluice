import { AbortError, CorruptFileError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { zipReader } from '../src/readers/zip/index.js';
import { openZip } from '../src/zip/index.js';

/** Bounded direct-reader entry point for byte-oriented ZIP reader fuzzing. */
export async function fuzzReaderZip(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      compressionRatio: 20,
      compressionRatioMinBytes: 1_024,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      timeMs: 1_000,
    },
    { onLimit: 'truncate' },
  );
  const options: ResolvedOptions = {
    children: 'extract',
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const out = new DocBuilder('zip', 'application/zip', budget, options);

  try {
    const context: ReadContext = {
      bytes: input,
      options,
      budget,
      warnings: budget.warnings,
      out,
      path: '',
      zip: openZip(input, budget),
      extractChild: () => Promise.resolve(),
    };
    await zipReader.read(context);
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

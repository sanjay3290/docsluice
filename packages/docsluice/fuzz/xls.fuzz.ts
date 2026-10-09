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
import { DocBuilder } from '../src/core/builder.js';
import { WarningSink } from '../src/core/warnings.js';
import { xlsReader } from '../src/readers/xls/index.js';
import type { ReadContext } from '../src/core/reader.js';

/** Exercise the XLS adapter on mutated CFB files with strict input, output, and time bounds. */
export async function fuzzXls(input: Uint8Array): Promise<void> {
  const sample = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const limits = resolveLimits({
    inputBytes: 1_000_000,
    totalUncompressedBytes: 1_000_000,
    cells: 20_000,
    outputChars: 65_536,
    timeMs: 1_000,
  });
  const budget = new Budget(limits, { warnings });
  try {
    const context: ReadContext = {
      bytes: sample,
      options: {
        limits,
        onLimit: 'truncate',
        strict: false,
        metadata: true,
        children: 'extract',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
        formulas: false,
      },
      budget,
      warnings,
      out: new DocBuilder('xls', 'application/vnd.ms-excel', budget),
      path: '',
      extractChild: () => Promise.resolve(),
    };
    await xlsReader.read(context);
    context.out.finish();
  } catch (error) {
    if (
      error instanceof AbortError ||
      error instanceof CorruptFileError ||
      error instanceof EncryptedError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError ||
      error instanceof UnsupportedFormatError
    ) {
      return;
    }
    throw error;
  }
}

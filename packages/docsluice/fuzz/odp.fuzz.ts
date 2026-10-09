import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  TimeoutError,
} from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { odpReader } from '../src/readers/odp/index.js';

/** Bounded reader fuzz entry point; invalid packages and configured limits are ordinary outcomes. */
export async function fuzzOdp(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      totalUncompressedBytes: 1_000_000,
      zipEntries: 100,
      xmlDepth: 64,
      outputChars: 65_536,
      timeMs: 1_000,
    },
    { warnings, onLimit: 'truncate' },
  );
  const out = new DocBuilder('odp', 'application/vnd.oasis.opendocument.presentation', budget);
  const ctx = {
    bytes: input,
    options: { metadata: true, runs: false, includeHidden: false },
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
  } as unknown as ReadContext;
  try {
    await odpReader.read(ctx);
    out.finish();
  } catch (error) {
    if (
      error instanceof AbortError ||
      error instanceof CorruptFileError ||
      error instanceof EncryptedError ||
      error instanceof LimitExceededError ||
      error instanceof TimeoutError
    )
      return;
    throw error;
  }
}

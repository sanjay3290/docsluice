import { AbortError, LimitExceededError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { csvReader, tsvReader } from '../src/readers/csv/index.js';

/** Byte-oriented fuzz entry point for malformed CSV and TSV input. */
export async function fuzzCsv(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  for (const reader of [csvReader, tsvReader]) {
    const warnings = new WarningSink();
    const budget = new Budget(
      { ...DEFAULT_LIMITS, cells: 10_000, outputChars: 65_536, timeMs: 1_000 },
      { warnings },
    );
    const out = new DocBuilder(reader.id, reader.mimeTypes[0]!, budget);
    const ctx = {
      bytes: input,
      options: { limits: budget.limits, runs: false } as ResolvedOptions,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    try {
      await reader.read(ctx);
      out.finish();
    } catch (error) {
      // Aborts and budget errors are normal fuzz outcomes; anything else is a finding.
      if (error instanceof AbortError || error instanceof LimitExceededError || error instanceof TimeoutError)
        continue;
      throw error;
    }
  }
}

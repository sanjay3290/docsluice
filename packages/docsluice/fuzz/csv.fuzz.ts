import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { csvReader, readDelimitedStream, tsvReader } from '../src/readers/csv/index.js';

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
    } catch {
      // Invalid text, aborts and expected budget errors are normal fuzz outcomes.
    }
  }

  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, cells: 10_000, outputChars: 65_536, timeMs: 1_000 },
    { warnings },
  );
  const out = new DocBuilder('csv', 'text/csv', budget);
  const chunks = async function* () {
    await Promise.resolve();
    for (let offset = 0; offset < input.length; offset += 8_192) {
      budget.tick();
      yield input.subarray(offset, Math.min(input.length, offset + 8_192));
    }
  };
  try {
    await readDelimitedStream(
      { budget, warnings, path: '', out },
      { prefix: input.subarray(0, 8_192), chunks },
      async () => {},
    );
    out.finish();
  } catch {
    // Invalid bytes and expected resource limits are ordinary fuzz outcomes.
  }
}

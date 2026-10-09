import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import reader from '../src/readers/json/index.js';

/** Fuzz harness entry point for the bounded JSON reader. */
export async function fuzzJson(input: Uint8Array): Promise<void> {
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, inputBytes: 1_000_000, outputChars: 65_536, timeMs: 1000 },
    { warnings },
  );
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder('json', 'application/json', budget, options);
  const ctx = {
    bytes: input,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  out.finish();
}

import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import reader from '../src/readers/txt/index.js';
import type { ResolvedOptions } from '../src/core/options.js';

/** Fuzz arbitrary byte sequences through the production TXT reader and builder. */
export async function fuzzTxt(bytes: Uint8Array): Promise<void> {
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, inputBytes: 1_000_000, outputChars: 65_536, timeMs: 1_000 },
    { warnings },
  );
  const out = new DocBuilder('txt', 'text/plain', budget);
  const ctx = {
    bytes,
    options: { limits: budget.limits, runs: false } as ResolvedOptions,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  out.finish();
}

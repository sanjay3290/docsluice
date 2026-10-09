import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { imageReaders } from '../src/readers/images/index.js';

/** Fuzz harness entry point: arbitrary bytes must be bounded and must never leak parser errors. */
export async function fuzzImage(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 64 * 1024);
  for (const reader of imageReaders) {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 1000 }, { warnings });
    const options = { metadata: true, imageGps: false } as ResolvedOptions;
    const out = new DocBuilder(reader.id, reader.mimeTypes[0]!, budget, options);
    const ctx: ReadContext = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(),
    };
    await reader.read(ctx);
    out.finish();
  }
}

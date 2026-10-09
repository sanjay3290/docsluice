import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { DocBuilder } from '../src/core/builder.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import epubReader from '../src/readers/epub/index.js';

/** Run bounded arbitrary bytes through the EPUB ZIP/XML/package path. */
export async function fuzzEpub(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits({ blockDepth: 64, outputChars: 65_536, timeMs: 1_000 }), {
    warnings,
  });
  const options = { limits: budget.limits, metadata: true, includeHidden: false } as ResolvedOptions;
  const out = new DocBuilder('epub', 'application/epub+zip', budget, options);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  try {
    await epubReader.read(ctx);
    out.finish();
  } catch (error) {
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

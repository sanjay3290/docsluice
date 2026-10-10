import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DocsluiceError } from '../src/core/errors.js';
import { resolveLimits } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { readHtml } from '../src/readers/html/read.js';

/**
 * Bounded HTML parser entry point, run with and without main-content selection (HTM-2); unexpected
 * parser errors remain fuzz failures. Each run gets under half of the 1 s per-input timeout.
 */
export async function fuzzHtml(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 64 * 1024);
  for (const mainContent of [false, true]) {
    const budget = new Budget(
      resolveLimits({
        inputBytes: 64 * 1024,
        outputChars: 32 * 1024,
        cells: 1024,
        blockDepth: 32,
        timeMs: 450,
      }),
    );
    const options = { limits: budget.limits, runs: true, metadata: false, mainContent } as ResolvedOptions;
    const out = new DocBuilder('html', 'text/html', budget, options);
    try {
      await readHtml({
        bytes,
        options,
        budget,
        warnings: budget.warnings,
        out,
        path: '',
        extractChild: async () => {},
      });
      out.finish();
    } catch (error) {
      if (!(error instanceof DocsluiceError)) throw error;
    }
  }
}

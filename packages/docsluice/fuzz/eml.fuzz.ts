import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { reader } from '../src/readers/eml/index.js';

/** Exercise EML parsing and block emission with one shared bounded budget. */
export async function fuzzEml(input: Uint8Array): Promise<void> {
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, inputBytes: 256 * 1024, xmlDepth: 32, outputChars: 65_536, timeMs: 1000 },
    { warnings },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: false,
    children: 'list',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const out = new DocBuilder('eml', 'message/rfc822', budget, options);
  const context: ReadContext = {
    bytes: input.subarray(0, 256 * 1024),
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
  };
  await reader.read(context);
  out.finish();
}

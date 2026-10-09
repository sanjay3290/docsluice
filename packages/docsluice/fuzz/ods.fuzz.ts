import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { reader } from '../src/readers/ods/index.js';
import { openZip } from '../src/zip/index.js';

/** Fuzz the ODS package and reader with bounded arbitrary archive bytes. */
export async function fuzzOds(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, cells: 1_000, timeMs: 1_000 },
    { warnings, onLimit: 'truncate' },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  try {
    const zip = openZip(input, budget);
    const out = new DocBuilder('ods', 'application/vnd.oasis.opendocument.spreadsheet', budget, options);
    await reader.read({
      bytes: input,
      options,
      budget,
      warnings,
      out,
      path: '',
      zip,
      async extractChild() {},
    });
    out.finish();
  } catch {
    // Arbitrary bytes may be corrupt; fuzzer assertions concern hangs and crashes.
  }
}

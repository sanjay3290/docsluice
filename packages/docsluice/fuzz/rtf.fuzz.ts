import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { resolveLimits } from '../src/core/limits.js';
import { DocBuilder } from '../src/core/builder.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { rtfReader } from '../src/readers/rtf/index.js';

/** Bounded byte-oriented harness for arbitrary RTF and malformed control sequences. */
export async function fuzzRtf(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    resolveLimits({ xmlDepth: 64, outputChars: 65_536, totalUncompressedBytes: 4_000_000, timeMs: 1_000 }),
    {
      warnings,
    },
  );
  // Vary the options from the input so runs, revision modes and hidden text are all exercised.
  const flags = bytes.length > 0 ? bytes[bytes.length - 1]! : 0;
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: (flags & 1) === 0,
    children: 'list',
    childBytes: (flags & 2) !== 0,
    runs: (flags & 4) !== 0,
    revisions: (['accept', 'reject', 'show'] as const)[(flags >> 3) % 3]!,
    includeHidden: (flags & 32) !== 0,
    formulas: false,
  };
  const out = new DocBuilder('rtf', 'application/rtf', budget, options);
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
    await rtfReader.read(ctx);
    out.finish();
  } catch (error) {
    // Malformed input and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

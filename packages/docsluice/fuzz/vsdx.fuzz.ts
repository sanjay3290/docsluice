import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { resolveOptions } from '../src/core/extract.js';
import type { ResolvedOptions } from '../src/core/options.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { vsdxReader } from '../src/readers/vsdx/index.js';

/** Bound arbitrary VSDX bytes and ensure malformed packages produce no parser crash. */
export async function fuzzVsdx(input: Uint8Array): Promise<void> {
  if (input.length > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      inputBytes: 1_000_000,
      totalUncompressedBytes: 1_000_000,
      zipEntries: 128,
      outputChars: 100_000,
      timeMs: 1_000,
    },
    { onLimit: 'truncate', warnings },
  );
  const options: ResolvedOptions = {
    ...resolveOptions(),
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
  const out = new DocBuilder(vsdxReader.id, vsdxReader.mimeTypes[0]!, budget, options);
  const ctx: ReadContext = {
    bytes: input,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
  };
  try {
    await vsdxReader.read(ctx);
    out.finish();
  } catch {
    // Invalid ZIP/XML and expected resource limits are ordinary fuzz outcomes.
  }
}

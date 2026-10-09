import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { Reader, ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';

export async function fuzzTextReader(reader: Reader, input: Uint8Array, filename?: string): Promise<void> {
  const bytes = input.subarray(0, Math.min(input.length, 1_000_000));
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, outputChars: 65_536, blockDepth: 32, timeMs: 1_000 },
    { warnings },
  );
  const out = new DocBuilder(reader.id, reader.mimeTypes[0] ?? 'text/plain', budget);
  const options = { limits: budget.limits, runs: true, metadata: true } as ResolvedOptions;
  const ctx = {
    bytes,
    filename,
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

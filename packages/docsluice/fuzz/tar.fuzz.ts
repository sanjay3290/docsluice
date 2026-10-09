import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { reader } from '../src/readers/tar/index.js';

/** Bounded entry point for byte-oriented TAR fuzzing. */
export async function fuzzTar(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, zipEntries: 100, totalUncompressedBytes: 2_000_000, timeMs: 1_000 },
    { warnings, onLimit: 'truncate' },
  );
  const options = {
    children: 'extract',
    childBytes: false,
    metadata: true,
    runs: false,
  } as ReadContext['options'];
  const out = new DocBuilder('tar', 'application/x-tar', budget, options);
  const context: ReadContext = { bytes, options, budget, warnings, out, path: '', async extractChild() {} };
  try {
    await reader.read(context);
    out.finish();
  } catch {
    // Invalid archives and expected resource limits are ordinary fuzz outcomes.
  }
}

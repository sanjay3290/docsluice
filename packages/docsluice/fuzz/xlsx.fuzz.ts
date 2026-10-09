import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { DocBuilder } from '../src/core/builder.js';
import { WarningSink } from '../src/core/warnings.js';
import { xlsxReader } from '../src/readers/xlsx/index.js';
import { openZip } from '../src/zip/index.js';

/** Bounded fuzz entry point for workbook relationships, shared strings and sparse sheets. */
export async function fuzzXlsx(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      compressionRatio: 20,
      compressionRatioMinBytes: 1_024,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      cells: 10_000,
      outputChars: 100_000,
      xmlDepth: 64,
      timeMs: 1_000,
    },
    { warnings, onLimit: 'truncate' },
  );
  const options = { metadata: false } as ResolvedOptions;
  const out = new DocBuilder(
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    budget,
    options,
  );
  try {
    const zip = openZip(bytes, budget);
    await xlsxReader.read({
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      zip,
      extractChild: () => Promise.resolve(),
    });
    out.finish();
  } catch {
    // Invalid packages and expected resource-limit errors are ordinary fuzz outcomes.
  }
}

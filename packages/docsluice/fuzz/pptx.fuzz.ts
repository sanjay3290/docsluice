import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { pptxReader } from '../src/readers/pptx/index.js';
import { openZip } from '../src/zip/index.js';

const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** Bounded fuzz entry point for the PPTX reader and its package relationships. */
export async function fuzzPptx(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const limits = {
    ...DEFAULT_LIMITS,
    compressionRatio: 20,
    compressionRatioMinBytes: 1_024,
    totalUncompressedBytes: 2_000_000,
    zipEntries: 100,
    xmlDepth: 64,
    blockDepth: 32,
    outputChars: 100_000,
    timeMs: 1_000,
  };
  const budget = new Budget(limits, { warnings, onLimit: 'truncate' });
  try {
    const out = new DocBuilder('pptx', MIME, budget);
    const context = {
      bytes,
      options: {
        limits,
        onLimit: 'truncate',
        strict: false,
        metadata: false,
        children: 'skip',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
        formulas: false,
      },
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(undefined),
      zip: openZip(bytes, budget),
    } as ReadContext;
    await pptxReader.read(context);
    out.finish();
  } catch {
    // Invalid archives and expected budget failures are normal fuzz outcomes.
  }
}

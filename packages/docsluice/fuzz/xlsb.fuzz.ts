import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DocsluiceError } from '../src/core/errors.js';
import { DEFAULT_LIMITS, resolveLimits } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { xlsbReader } from '../src/readers/xlsb/index.js';
import { openZip } from '../src/zip/index.js';

const MAX_FUZZ_INPUT = 1_000_000;
const MIME = 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';

/** Bounded whole-workbook fuzz target; malformed packages are ordinary outcomes. */
export async function fuzzXlsb(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > MAX_FUZZ_INPUT) return;
  const warnings = new WarningSink();
  const limits = resolveLimits({
    ...DEFAULT_LIMITS,
    inputBytes: MAX_FUZZ_INPUT,
    totalUncompressedBytes: 2_000_000,
    zipEntries: 100,
    cells: 50_000,
    outputChars: 100_000,
    timeMs: 1_000,
  });
  const budget = new Budget(limits, { warnings, onLimit: 'truncate' });
  const options: ResolvedOptions = {
    filename: 'fuzz.xlsb',
    limits,
    onLimit: 'truncate',
    strict: false,
    metadata: false,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: true,
    formulas: true,
  };
  const builder = new DocBuilder('xlsb', MIME, budget, options);
  try {
    const context: ReadContext = {
      bytes,
      filename: options.filename!,
      options,
      budget,
      warnings,
      out: builder,
      path: '',
      async extractChild() {},
      zip: openZip(bytes, budget),
    };
    await xlsbReader.read(context);
    builder.finish();
  } catch (error) {
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

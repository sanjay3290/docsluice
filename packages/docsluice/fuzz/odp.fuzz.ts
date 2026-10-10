import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { emptyOdpStyles, parseOdpXml } from '../src/readers/odp/content.js';
import { odpReader } from '../src/readers/odp/index.js';

/**
 * Fuzz the ODP reader with one bounded budget. A ZIP package goes through the reader; any other
 * input is parsed as `content.xml`, so mutations reach the slide parser directly.
 */
export async function fuzzOdp(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      cells: 65_536,
      zipEntries: 4_096,
      totalUncompressedBytes: 8_000_000,
      outputChars: 262_144,
      timeMs: 1_000,
    },
    { warnings },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'list',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: true,
  };
  try {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      parseOdpXml(bytes, emptyOdpStyles(), { budget, warnings });
      return;
    }
    const out = new DocBuilder('odp', 'application/vnd.oasis.opendocument.presentation', budget, options);
    const context: ReadContext = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(),
    };
    await odpReader.read(context);
    out.finish();
  } catch (error) {
    // Malformed packages and XML, encryption and limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { odtReader } from '../src/readers/odt/index.js';
import { openZip } from '../src/zip/index.js';

/** Bounded byte-oriented fuzz target for ODT package parsing and block extraction. */
export async function fuzzOdt(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      xmlDepth: 64,
      blockDepth: 32,
      outputChars: 65_536,
      timeMs: 1_000,
    },
    { warnings, onLimit: 'truncate' },
  );
  try {
    const zip = openZip(bytes, budget);
    const context = {
      bytes,
      options: {
        metadata: true,
        children: 'list',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
      },
      budget,
      warnings,
      out: new DocBuilder('odt', 'application/vnd.oasis.opendocument.text', budget),
      path: '',
      extractChild: async () => {},
      zip,
    };
    await odtReader.read(context as never);
    context.out.finish();
  } catch (error) {
    // Malformed archives, limits and encryption are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

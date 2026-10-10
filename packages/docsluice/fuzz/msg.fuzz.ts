import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { openCfb } from '../src/ole/index.js';
import { msgReader } from '../src/readers/msg/index.js';
import { decompressRtf } from '../src/readers/msg/lzfu.js';

/**
 * Fuzz the MSG reader with one bounded budget. A compound file is read as a message, and each
 * repacked attachment is opened again; any other input goes straight to the LZFu decompressor.
 */
export async function fuzzMsg(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      zipEntries: 4_096,
      totalUncompressedBytes: 8_000_000,
      outputChars: 65_536,
      timeMs: 1_000,
    },
    { warnings },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'extract',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  try {
    if (bytes[0] !== 0xd0 || bytes[1] !== 0xcf) {
      decompressRtf(bytes, budget);
      return;
    }
    const out = new DocBuilder('msg', 'application/vnd.ms-outlook', budget, options);
    const context: ReadContext = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild(_name, child) {
        if (child[0] === 0xd0 && child[1] === 0xcf) openCfb(child, budget);
        return Promise.resolve();
      },
    };
    await msgReader.read(context);
    out.finish();
  } catch (error) {
    // Malformed compound files and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

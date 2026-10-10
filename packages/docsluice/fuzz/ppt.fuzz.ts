import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DocsluiceError } from '../src/core/errors.js';
import { resolveLimits } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { pptReader } from '../src/readers/ppt/index.js';
import { parsePresentation } from '../src/readers/ppt/records.js';

const budgetFor = (warnings: WarningSink) =>
  new Budget(resolveLimits({ totalUncompressedBytes: 1_000_000, outputChars: 65_536, timeMs: 1_000 }), {
    warnings,
  });

/** A Current User stream whose edit offset points where a last UserEditAtom usually sits. */
function currentUser(documentLength: number): Uint8Array {
  const bytes = new Uint8Array(8 + 20);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 0x0ff6, true);
  view.setUint32(4, 20, true);
  view.setUint32(8, 20, true);
  view.setUint32(12, 0xe391c05f, true);
  view.setUint32(16, Math.max(0, documentLength - 36), true);
  return bytes;
}

/**
 * Run the PPT reader on a mutated compound file, and the record parser on the raw bytes as a
 * `PowerPoint Document` stream, so mutations reach the records without a valid CFB around them.
 */
export async function fuzzPpt(input: Uint8Array): Promise<void> {
  const sample = input.subarray(0, 1_000_000);
  try {
    const warnings = new WarningSink();
    const budget = budgetFor(warnings);
    parsePresentation(sample, currentUser(sample.length), budget, warnings);
  } catch (error) {
    if (!(error instanceof DocsluiceError)) throw error;
  }
  const warnings = new WarningSink();
  const budget = budgetFor(warnings);
  const ctx: ReadContext = {
    bytes: sample,
    options: {
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
    },
    budget,
    warnings,
    out: new DocBuilder('ppt', 'application/vnd.ms-powerpoint', budget),
    path: '',
    extractChild: async () => {},
  };
  try {
    await pptReader.read(ctx);
  } catch (error) {
    // Malformed files and resource limits are ordinary outcomes; anything else is a finding.
    if (!(error instanceof DocsluiceError)) throw error;
  }
}

import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DocsluiceError } from '../src/core/errors.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ResolvedOptions } from '../src/core/options.js';
import type { ReadContext } from '../src/core/reader.js';
import { WarningSink } from '../src/core/warnings.js';
import { mboxReader } from '../src/readers/mbox/index.js';

/** Split and unescape mailboxes; children are handed to a stub that only checks their bounds. */
export async function fuzzMbox(input: Uint8Array): Promise<void> {
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, inputBytes: 256 * 1024, outputChars: 65_536, timeMs: 1000 },
    { warnings },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: false,
    children: input.length % 2 === 0 ? 'extract' : 'list',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const sample = input.subarray(0, 256 * 1024);
  const context: ReadContext = {
    bytes: sample,
    options,
    budget,
    warnings,
    out: new DocBuilder('mbox', 'application/mbox', budget, options),
    path: '',
    extractChild: (_name, bytes) => {
      if (bytes.length > sample.length) throw new Error('A message is larger than its mailbox.');
      return Promise.resolve();
    },
  };
  try {
    await mboxReader.read(context);
  } catch (error) {
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

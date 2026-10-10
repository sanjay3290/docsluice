import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { parseDocxStyles } from '../src/readers/docx/styles.js';
import { scanDocxBody } from '../src/readers/docx/body.js';
import { parseDocxNumbering } from '../src/readers/docx/numbering.js';
import { readDocxNotes, readDocxStoryText } from '../src/readers/docx/stories.js';
import { WarningSink } from '../src/core/warnings.js';

/** Bounded entry point for arbitrary XML payloads sent through both DOCX SAX modules. */
export function fuzzDocx(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, timeMs: 1_000 },
    { warnings },
  );
  const context = {
    budget,
    warnings,
    out: new DocBuilder('docx', 'application/docx', budget, { runs: true }),
    options: { runs: true },
  };
  try {
    parseDocxNumbering(sample, context);
    readDocxStoryText(sample, context);
    readDocxNotes(sample, context, 'comment');
    const styles = parseDocxStyles(sample, context);
    scanDocxBody(sample, context, styles, new Map());
  } catch (error) {
    // Malformed XML and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

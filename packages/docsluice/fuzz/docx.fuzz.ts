import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { parseDocxStyles } from '../src/readers/docx/styles.js';
import { scanDocxBody } from '../src/readers/docx/body.js';
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
    const styles = parseDocxStyles(sample, context);
    scanDocxBody(sample, context, styles, new Map());
  } catch {
    // Malformed XML and ordinary resource limits are expected fuzz outcomes.
  }
}

import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseDiagramData } from '../src/readers/pptx/diagram.js';
import { parseSlide } from '../src/readers/pptx/slide.js';

/** Bounded entry point for arbitrary XML payloads sent through the slide and SmartArt parsers. */
export function fuzzPptx(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, xmlDepth: 64, blockDepth: 16, outputChars: 65_536, cells: 65_536, timeMs: 1_000 },
    { warnings },
  );
  const context = { budget, warnings };
  try {
    parseSlide(sample, context);
    parseDiagramData(sample, context);
  } catch (error) {
    // Malformed XML and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

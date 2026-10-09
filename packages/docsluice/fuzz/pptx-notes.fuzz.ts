import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseSpeakerNotes } from '../src/readers/pptx/notes.js';
import { parseXml } from '../src/xml/index.js';

/** Bounded byte-oriented fuzz target for notes-part XML and its text extractor. */
export function fuzzPptxNotes(input: Uint8Array): void {
  if (input.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, timeMs: 1_000 },
    { warnings, onLimit: 'truncate' },
  );
  try {
    const root = parseXml(input, { budget, warnings });
    if (root) parseSpeakerNotes(root, budget);
  } catch {
    // Malformed XML and expected resource-limit errors are ordinary fuzz outcomes.
  }
}

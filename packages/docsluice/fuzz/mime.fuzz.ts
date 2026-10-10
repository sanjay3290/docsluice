import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { parseHeaders, parseMime } from '../src/mime/index.js';

/** Fuzz the hand-written RFC 5322/MIME parser with bounded input and nesting. */
export function fuzzMime(input: Uint8Array): void {
  const sample = input.subarray(0, Math.min(input.length, 256 * 1024));
  const budget = new Budget({ ...DEFAULT_LIMITS, inputBytes: 256 * 1024, xmlDepth: 32, timeMs: 1000 });
  try {
    parseHeaders(new TextDecoder().decode(sample), budget);
    parseMime(sample, budget);
  } catch (error) {
    // Malformed MIME and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

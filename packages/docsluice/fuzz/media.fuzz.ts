import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseMedia } from '../src/readers/media/parse.js';

/**
 * Fuzz the audio and video container parsers (#248). The input is read as the container its
 * signature names: ID3/MP3, FLAC, Ogg, WAV or MP4.
 */
export function fuzzMedia(input: Uint8Array): void {
  const bytes = input.subarray(0, 1_000_000);
  const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 1_000 }, { warnings: new WarningSink() });
  try {
    parseMedia(bytes, budget);
  } catch (error) {
    // Time limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

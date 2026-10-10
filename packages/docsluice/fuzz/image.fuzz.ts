import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { readTiff } from '../src/readers/image/exif.js';
import { imageFormat, imageInfo } from '../src/readers/image/index.js';

/**
 * Fuzz the image header and EXIF parsers. The input is read as the format its signature names, and
 * also as a bare TIFF/EXIF block, so mutations reach the IFD walker directly.
 */
export function fuzzImage(input: Uint8Array): void {
  const bytes = input.subarray(0, 1_000_000);
  const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 1_000 }, { warnings: new WarningSink() });
  try {
    imageInfo(imageFormat(bytes), bytes, budget);
    readTiff(bytes, budget);
  } catch (error) {
    // Time limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

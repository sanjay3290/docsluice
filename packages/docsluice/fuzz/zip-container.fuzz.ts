import { DocsluiceError } from '../src/core/errors.js';
import { extract } from '../src/core/extract.js';

/** Bounded entry point: arbitrary bytes read as a ZIP container, children extracted under one budget. */
export async function fuzzZipContainer(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  try {
    await extract(input, {
      format: 'zip',
      limits: {
        compressionRatio: 20,
        compressionRatioMinBytes: 1_024,
        totalUncompressedBytes: 2_000_000,
        zipEntries: 100,
        outputChars: 65_536,
        timeMs: 1_000,
      },
    });
  } catch (error) {
    // Malformed archives and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

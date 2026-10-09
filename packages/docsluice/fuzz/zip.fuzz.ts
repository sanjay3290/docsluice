import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { openZip } from '../src/zip/index.js';

/** Bounded entry point for the repository's byte-oriented ZIP fuzz runner. */
export async function fuzzZip(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      compressionRatio: 20,
      compressionRatioMinBytes: 1_024,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      timeMs: 1_000,
    },
    { onLimit: 'truncate' },
  );
  try {
    const archive = openZip(bytes, budget);
    for (const entry of archive.entries) {
      budget.tick();
      await archive.read(entry);
    }
  } catch {
    // Invalid bytes and expected resource limits are ordinary fuzz outcomes.
  }
}

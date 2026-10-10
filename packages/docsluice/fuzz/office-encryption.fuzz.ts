import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { openCfb } from '../src/ole/index.js';
import { decryptOffice } from '../src/office/encryption/index.js';

/** Private, bounded target; shared fuzz registration belongs to the lead. */
export async function fuzzOfficeEncryption(bytes: Uint8Array): Promise<void> {
  if (bytes.length > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      xmlDepth: 64,
      outputChars: 100_000,
      timeMs: 50,
    },
    { warnings, onLimit: 'throw' },
  );
  try {
    const cfb = openCfb(bytes, budget);
    await decryptOffice(cfb, 'Public test é😀', { budget, warnings });
  } catch {
    // Malformed descriptors, wrong passwords and resource limits are expected.
  }
}

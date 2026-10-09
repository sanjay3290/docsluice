import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { readContentTypes } from '../src/ooxml/content-types.js';
import { scanFeatures } from '../src/ooxml/features.js';
import { OoxmlParts } from '../src/ooxml/parts.js';
import { readProperties } from '../src/ooxml/props.js';
import { openZip } from '../src/zip/index.js';

/** Bounded, standalone fuzz target for hostile OOXML package bytes. */
export async function fuzzOoxml(bytes: Uint8Array): Promise<void> {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      compressionRatio: 20,
      compressionRatioMinBytes: 1_024,
      totalUncompressedBytes: 2_000_000,
      zipEntries: 100,
      xmlDepth: 64,
      timeMs: 1_000,
    },
    { warnings, onLimit: 'truncate' },
  );
  try {
    const archive = openZip(bytes, budget);
    const ctx = { budget, warnings };
    const parts = new OoxmlParts(archive, ctx);
    await readContentTypes(parts, ctx);
    await readProperties(parts, ctx, false);
    await scanFeatures(parts, archive, ctx);
  } catch {
    // Invalid packages and expected resource-limit errors are ordinary fuzz outcomes.
  }
}

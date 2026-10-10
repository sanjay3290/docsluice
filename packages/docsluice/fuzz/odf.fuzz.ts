import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseOdfManifest } from '../src/odf/manifest.js';
import { parseOdfMetadata } from '../src/odf/meta.js';
import { parseOdfStyles } from '../src/odf/styles.js';
import type { XmlContext } from '../src/xml/index.js';

function context(): XmlContext {
  const warnings = new WarningSink();
  return {
    budget: new Budget(
      { ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, timeMs: 1_000 },
      { warnings, onLimit: 'truncate' },
    ),
    warnings,
  };
}

/** Fuzz all ODF metadata helpers with arbitrary, bounded XML part bytes. */
export function fuzzOdf(input: Uint8Array): void {
  if (input.byteLength > 1_000_000) return;
  for (const parse of [parseOdfMetadata, parseOdfStyles, parseOdfManifest]) {
    try {
      parse(input, context());
    } catch (error) {
      // Malformed XML and resource limits are ordinary outcomes; anything else is a finding.
      if (!(error instanceof DocsluiceError)) throw error;
    }
  }
}

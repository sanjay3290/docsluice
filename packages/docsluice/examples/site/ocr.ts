import type { DocsluiceDocument } from '../../src/index.js';

/** A routing decision only; OCR itself is an external application concern and is not bundled here. */
export function routeForOcr(
  document: DocsluiceDocument,
): { action: 'ocr'; reason: 'text-layer-missing' } | { action: 'skip' } {
  return document.stats.needsOcr ? { action: 'ocr', reason: 'text-layer-missing' } : { action: 'skip' };
}

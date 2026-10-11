// Load the PDF engine before the fuzz runner snapshots built-in prototypes: pdf.js installs its
// polyfills (DOMMatrix, Map.prototype.getOrInsertComputed, Uint8Array.prototype.toHex,
// Math.sumPrecise) once on load, which is not something a fuzz input causes.
import 'unpdf/pdfjs';
import { DocsluiceError } from '../src/core/errors.js';
import { extract } from '../src/core/extract.js';

/** Bounded entry point: arbitrary bytes read as a PDF under tight page, output and time limits. */
export async function fuzzPdf(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  try {
    await extract(input, {
      format: 'pdf',
      runs: true,
      // Each font may hold a 65,536-code CMap (about 7 MB); 32 fonts keep one run well inside the cap.
      limits: { pdfPages: 20, pdfFonts: 32, outputChars: 65_536, timeMs: 2_000 },
    });
  } catch (error) {
    // Malformed PDFs, passwords and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

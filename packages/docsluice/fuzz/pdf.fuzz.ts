import { DocsluiceError } from '../src/core/errors.js';
import { extract } from '../src/core/extract.js';

/** Bounded entry point: arbitrary bytes read as a PDF under tight page, output and time limits. */
export async function fuzzPdf(input: Uint8Array): Promise<void> {
  if (input.byteLength > 1_000_000) return;
  try {
    await extract(input, {
      format: 'pdf',
      runs: true,
      limits: { pdfPages: 20, outputChars: 65_536, timeMs: 2_000 },
    });
  } catch (error) {
    // Malformed PDFs, passwords and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

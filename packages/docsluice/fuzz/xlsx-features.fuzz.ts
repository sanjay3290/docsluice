import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { parseA1RangeReference, parseWorkbookDefinedNames } from '../src/readers/xlsx/features.js';
import type { WorkbookSheet } from '../src/readers/xlsx/sheets.js';

/** Bounded feature-parser fuzz entry point for workbook defined names and A1 references. */
export function fuzzXlsxFeatures(bytes: Uint8Array): void {
  if (bytes.byteLength > 1_000_000) return;
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      inputBytes: 1_000_000,
      totalUncompressedBytes: 1_000_000,
      outputChars: 100_000,
      xmlDepth: 64,
      timeMs: 1_000,
    },
    { warnings, onLimit: 'truncate' },
  );
  const sheets: WorkbookSheet[] = [{ name: 'Sheet1', part: 'xl/worksheets/sheet1.xml', state: 'visible' }];
  const context = { budget, warnings, path: 'xl/workbook.xml' };
  try {
    parseWorkbookDefinedNames(bytes, sheets, context);
    const reference = new TextDecoder().decode(bytes.subarray(0, 1_024));
    parseA1RangeReference(reference, budget);
  } catch {
    // Malformed XML and expected resource-limit errors are ordinary fuzz outcomes.
  }
}

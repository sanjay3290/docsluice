import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { regionRows, sheetRegions } from '../src/readers/xlsx/layout.js';
import { parseSharedStrings } from '../src/readers/xlsx/shared-strings.js';
import { parseWorksheet } from '../src/readers/xlsx/sheet.js';
import { parseStyles } from '../src/readers/xlsx/styles.js';
import { parseWorkbook } from '../src/readers/xlsx/workbook.js';

/** Bounded entry point for arbitrary XML payloads sent through every XLSX SAX module, number formats and the grid layout. */
export function fuzzXlsx(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, xmlDepth: 64, outputChars: 65_536, cells: 65_536, timeMs: 1_000 },
    { warnings },
  );
  const context = { budget, warnings };
  try {
    parseWorkbook(sample, context);
    const sharedStrings = parseSharedStrings(sample, context);
    const styles = parseStyles(sample, context);
    const sheet = parseWorksheet(sample, {
      ...context,
      sharedStrings,
      styles,
      date1904: sample.length % 2 === 1,
      onBadSharedString: () => undefined,
    });
    for (const region of sheetRegions(sheet, budget)) regionRows(sheet, region, budget);
  } catch (error) {
    // Malformed XML and resource limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

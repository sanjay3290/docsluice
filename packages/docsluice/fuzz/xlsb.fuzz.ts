import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { GENERAL_STYLES } from '../src/readers/xlsx/styles.js';
import {
  parseXlsbSheet,
  parseXlsbStrings,
  parseXlsbStyles,
  parseXlsbWorkbook,
} from '../src/readers/xlsb/parse.js';
import { xlsbReader } from '../src/readers/xlsb/index.js';

/**
 * Fuzz the XLSB reader with one bounded budget. A ZIP package goes through the reader; any other
 * input is read as each binary part, so mutations reach the record parsers directly.
 */
export async function fuzzXlsb(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    {
      ...DEFAULT_LIMITS,
      cells: 65_536,
      zipEntries: 4_096,
      totalUncompressedBytes: 8_000_000,
      outputChars: 262_144,
      timeMs: 1_000,
    },
    { warnings },
  );
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'list',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: true,
  };
  try {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
      // A raw part: read it as every XLSB part kind, so mutations reach each record parser.
      parseXlsbWorkbook(bytes, budget);
      parseXlsbStyles(bytes, budget);
      const strings = parseXlsbStrings(bytes, budget);
      parseXlsbSheet(bytes, { budget, strings, styles: GENERAL_STYLES, date1904: false });
      return;
    }
    const out = new DocBuilder(
      'xlsb',
      'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
      budget,
      options,
    );
    const context: ReadContext = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(),
    };
    await xlsbReader.read(context);
    out.finish();
  } catch (error) {
    // Malformed packages and XML, encryption and limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

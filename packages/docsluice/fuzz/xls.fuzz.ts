import { Budget } from '../src/core/budget.js';
import { DocsluiceError } from '../src/core/errors.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { openCfb } from '../src/ole/index.js';
import { parseGlobals, parseSheet } from '../src/readers/xls/workbook.js';

/**
 * Fuzz the BIFF8 record parser. A compound file is opened and its Workbook stream parsed; any other
 * input is parsed as a raw Workbook stream, so mutations reach records directly.
 */
export function fuzzXls(input: Uint8Array): void {
  const bytes = input.subarray(0, 1_000_000);
  const warnings = new WarningSink();
  const budget = new Budget(
    { ...DEFAULT_LIMITS, cells: 65_536, zipEntries: 4_096, totalUncompressedBytes: 4_000_000, timeMs: 1_000 },
    { warnings },
  );
  const ctx = { budget, warnings };
  try {
    let stream = bytes;
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) {
      const archive = openCfb(bytes, budget);
      if (!archive.entries.some((entry) => entry.type === 'stream' && entry.path === 'Workbook')) return;
      stream = archive.read('Workbook');
    }
    const workbook = parseGlobals(stream, ctx);
    if (!workbook) return;
    const seen = new Set<number>();
    for (const sheet of workbook.sheets) {
      budget.tick();
      if (sheet.kind !== 0 || seen.has(sheet.offset)) continue;
      seen.add(sheet.offset);
      parseSheet(stream, sheet, workbook, ctx);
    }
  } catch (error) {
    // Malformed input, encryption and limits are ordinary outcomes; anything else is a finding.
    if (error instanceof DocsluiceError) return;
    throw error;
  }
}

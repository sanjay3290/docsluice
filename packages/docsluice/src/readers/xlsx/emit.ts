import type { Location } from '../../core/model.js';
import type { ReadContext } from '../../core/reader.js';
import { rangeName, regionRows, sheetRegions } from './layout.js';
import type { XlsxSheet } from './sheet.js';

/**
 * Emit a parsed sheet as one table per region, with the warnings for formula cells without a cached
 * value and for cells left out by limits. Shared by the XLSX and XLS readers so both give the same
 * tables. `index` is the zero-based sheet number used in warnings.
 */
export function emitSheetTables(
  ctx: ReadContext,
  sheet: XlsxSheet,
  index: number,
  sheetName: string | undefined,
  path: string | undefined,
): void {
  const warningLoc = path === undefined ? undefined : { path };
  let gridRows = 0;
  let gridCells = 0;
  let keptRows = 0;
  let keptCells = 0;
  let open = true;
  for (const region of sheetRegions(sheet, ctx.budget)) {
    ctx.budget.tick();
    const height = region.range.bottom - region.range.top + 1;
    gridRows += height;
    gridCells += height * (region.range.right - region.range.left + 1);
    if (!open) continue;
    const table = regionRows(sheet, region, ctx.budget);
    keptRows += table.rows.length;
    keptCells += table.cells;
    if (table.rows.length < height) open = false;
    const tableLoc: Location = {};
    if (sheetName !== undefined) tableLoc.sheet = sheetName;
    tableLoc.range = rangeName(region.range);
    if (table.rows.length > 0 && !ctx.out.table(table.rows, 0, tableLoc)) open = false;
  }
  if (sheet.missingCachedValues > 0) {
    ctx.warnings.add({
      code: 'UNREADABLE_PART',
      message: `Sheet ${index + 1}: ${sheet.missingCachedValues} formula cells have no cached value and are empty; formulas are never calculated.`,
      ...(warningLoc ? { loc: warningLoc } : {}),
    });
  }
  if (sheet.skippedCells > 0) ctx.budget.addCells(sheet.skippedCells);
  const skippedRows = gridRows - keptRows + sheet.skippedRows;
  const skippedCells = gridCells - keptCells + sheet.skippedCells;
  if (skippedCells > 0) {
    ctx.warnings.add({
      code: 'TRUNCATED',
      message: `Sheet ${index + 1}: kept ${keptRows} rows and ${keptCells} cells; skipped ${skippedRows} rows and ${skippedCells} cells.`,
      ...(warningLoc ? { loc: warningLoc } : {}),
    });
  }
}

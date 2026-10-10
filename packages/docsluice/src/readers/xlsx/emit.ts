import type { Location } from '../../core/model.js';
import type { ReadContext } from '../../core/reader.js';
import { guessHeaderRows } from './header.js';
import { rangeName, regionRows, sheetRegions } from './layout.js';
import type { XlsxRegion } from './layout.js';
import type { XlsxRange, XlsxSheet } from './sheet.js';

/** An Excel table (ListObject) or a defined name that covers a range of one sheet (XLS-9). */
export interface XlsxNamedRange {
  name: string;
  range: XlsxRange;
  /** An Excel table's own header row count (`headerRowCount`); defined names have none. */
  headerRows?: number;
}

/**
 * Emit a parsed sheet as one table per region, with the warnings for formula cells without a cached
 * value and for cells left out by limits. Shared by the XLSX, XLSB, XLS and ODS readers so all give
 * the same tables. `index` is the zero-based sheet number used in warnings.
 *
 * Header rows follow the `headerRow` option (XLS-8). A named range or Excel table that matches a
 * region exactly names it (`caption`); any other one becomes an extra table after the regions,
 * clipped to the cells in use, with its value cells charged again.
 */
export function emitSheetTables(
  ctx: ReadContext,
  sheet: XlsxSheet,
  index: number,
  sheetName: string | undefined,
  path: string | undefined,
  named: readonly XlsxNamedRange[] = [],
): void {
  const warningLoc = path === undefined ? undefined : { path };
  const mode = ctx.options.headerRow ?? 'auto';
  const used = new Set<XlsxNamedRange>();
  // Names by range, so matching regions stays linear however many names a workbook has.
  const byRange = new Map<string, XlsxNamedRange[]>();
  for (const range of named) {
    ctx.budget.tick();
    const key = rangeName(range.range);
    const list = byRange.get(key);
    if (list) list.push(range);
    else byRange.set(key, [range]);
  }
  const headerRows = (rows: Parameters<typeof guessHeaderRows>[0], range?: XlsxNamedRange): number =>
    mode === 'auto' && range?.headerRows !== undefined
      ? Math.min(range.headerRows, rows.length)
      : guessHeaderRows(rows, mode, ctx.budget);
  const tableLoc = (range: XlsxRange): Location => {
    const loc: Location = {};
    if (sheetName !== undefined) loc.sheet = sheetName;
    loc.range = rangeName(range);
    return loc;
  };
  let gridRows = 0;
  let gridCells = 0;
  let keptRows = 0;
  let keptCells = 0;
  let open = true;
  let bounds: XlsxRange | undefined;
  for (const region of sheetRegions(sheet, ctx.budget)) {
    ctx.budget.tick();
    const height = region.range.bottom - region.range.top + 1;
    gridRows += height;
    gridCells += height * (region.range.right - region.range.left + 1);
    bounds = bounds ? union(bounds, region.range) : { ...region.range };
    if (!open) continue;
    const table = regionRows(sheet, region, ctx.budget);
    keptRows += table.rows.length;
    keptCells += table.cells;
    if (table.rows.length < height) open = false;
    const match = byRange.get(rangeName(region.range))?.[0];
    if (match) used.add(match);
    if (
      table.rows.length > 0 &&
      !ctx.out.table(table.rows, headerRows(table.rows, match), tableLoc(region.range), match?.name)
    )
      open = false;
  }
  for (const range of named) {
    ctx.budget.tick();
    if (!open || !bounds || used.has(range)) continue;
    const clipped = intersect(range.range, bounds);
    if (!clipped) continue;
    const table = regionRows(sheet, regionFor(sheet, clipped, ctx), ctx.budget, true);
    if (table.rows.length < clipped.bottom - clipped.top + 1) open = false;
    if (
      table.rows.length > 0 &&
      !ctx.out.table(table.rows, headerRows(table.rows, range), tableLoc(clipped), range.name)
    )
      open = false;
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

function union(a: XlsxRange, b: XlsxRange): XlsxRange {
  return {
    top: Math.min(a.top, b.top),
    left: Math.min(a.left, b.left),
    bottom: Math.max(a.bottom, b.bottom),
    right: Math.max(a.right, b.right),
  };
}

function intersect(a: XlsxRange, b: XlsxRange): XlsxRange | undefined {
  const range = {
    top: Math.max(a.top, b.top),
    left: Math.max(a.left, b.left),
    bottom: Math.min(a.bottom, b.bottom),
    right: Math.min(a.right, b.right),
  };
  return range.top <= range.bottom && range.left <= range.right ? range : undefined;
}

/** A region for a named range: the merged ranges that start inside it, clipped to it. */
function regionFor(sheet: XlsxSheet, range: XlsxRange, ctx: ReadContext): XlsxRegion {
  const merges: XlsxRange[] = [];
  for (const merge of sheet.merges) {
    ctx.budget.tick();
    if (
      merge.top < range.top ||
      merge.top > range.bottom ||
      merge.left < range.left ||
      merge.left > range.right
    )
      continue;
    const clipped = {
      ...merge,
      bottom: Math.min(merge.bottom, range.bottom),
      right: Math.min(merge.right, range.right),
    };
    if (clipped.bottom > clipped.top || clipped.right > clipped.left) merges.push(clipped);
  }
  return { range, merges };
}

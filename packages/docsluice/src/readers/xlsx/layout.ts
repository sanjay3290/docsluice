import type { Budget } from '../../core/budget.js';
import type { Cell } from '../../core/model.js';
import { columnName } from './spreadsheetml.js';
import type { XlsxRange, XlsxSheet } from './sheet.js';

/** A used range up to this many grid cells is always one table. */
const DENSE_FLOOR = 10_000;
/** Larger used ranges stay one table only while at least one grid cell in this many holds a value. */
const DENSE_FACTOR = 4;

/** One table's range and the merged ranges inside it. */
export interface XlsxRegion {
  range: XlsxRange;
  merges: readonly XlsxRange[];
}

interface Interval {
  start: number;
  end: number;
}

function unite(intervals: Interval[], budget: Budget): Interval[] {
  intervals.sort((a, b) => {
    budget.tick();
    return a.start - b.start || a.end - b.end;
  });
  const united: Interval[] = [];
  for (const interval of intervals) {
    budget.tick();
    const last = united.at(-1);
    if (last && interval.start <= last.end + 1) last.end = Math.max(last.end, interval.end);
    else united.push({ start: interval.start, end: interval.end });
  }
  return united;
}

function sortedNumbers(values: Iterable<number>, budget: Budget): number[] {
  const sorted: number[] = [];
  for (const value of values) {
    budget.tick();
    sorted.push(value);
  }
  return sorted.sort((a, b) => {
    budget.tick();
    return a - b;
  });
}

/** Index of the interval holding `value`, by binary search over sorted, disjoint intervals. */
function findInterval(intervals: readonly Interval[], value: number, budget: Budget): number {
  let low = 0;
  let high = intervals.length - 1;
  while (low <= high) {
    budget.tick();
    const middle = (low + high) >>> 1;
    const interval = intervals[middle]!;
    if (value < interval.start) high = middle - 1;
    else if (value > interval.end) low = middle + 1;
    else return middle;
  }
  return -1;
}

/**
 * The tables a sheet becomes (XLS-5). The used range is the bounding box of value cells; `dimension`
 * and merged ranges do not widen it, so output stays proportional to real cells. The used range is
 * one table when it is small or mostly full. Otherwise it is split into bands of adjacent rows that
 * hold values, and each band into groups of adjacent columns that hold values, so a value in A1 and
 * one in Z90000 give two one-cell tables, not 2.3 million cells. A merged range belongs to the table
 * holding its top-left cell and is clipped to that table; other merges are dropped.
 */
export function sheetRegions(sheet: XlsxSheet, budget: Budget): XlsxRegion[] {
  const rowNumbers = sortedNumbers(sheet.rows.keys(), budget);
  let left = Number.POSITIVE_INFINITY;
  let right = 0;
  for (const row of rowNumbers) {
    budget.tick();
    for (const column of sheet.rows.get(row)!.keys()) {
      budget.tick();
      left = Math.min(left, column);
      right = Math.max(right, column);
    }
  }
  if (rowNumbers.length === 0) return [];
  const top = rowNumbers[0]!;
  const bottom = rowNumbers.at(-1)!;
  const area = (bottom - top + 1) * (right - left + 1);

  const bands: Interval[] = [];
  const groups: Interval[][] = [];
  if (area <= Math.max(DENSE_FLOOR, DENSE_FACTOR * sheet.stored)) {
    bands.push({ start: top, end: bottom });
    groups.push([{ start: left, end: right }]);
  } else {
    const rowIntervals: Interval[] = [];
    for (const row of rowNumbers) {
      budget.tick();
      rowIntervals.push({ start: row, end: row });
    }
    let rowIndex = 0;
    for (const band of unite(rowIntervals, budget)) {
      budget.tick();
      const columns: Interval[] = [];
      while (rowIndex < rowNumbers.length && rowNumbers[rowIndex]! <= band.end) {
        budget.tick();
        for (const column of sheet.rows.get(rowNumbers[rowIndex]!)!.keys()) {
          budget.tick();
          columns.push({ start: column, end: column });
        }
        rowIndex++;
      }
      bands.push(band);
      groups.push(unite(columns, budget));
    }
  }

  const regions: XlsxRegion[][] = [];
  for (let index = 0; index < bands.length; index++) {
    budget.tick();
    const band = bands[index]!;
    regions.push(
      groups[index]!.map((group) => {
        budget.tick();
        return {
          range: { top: band.start, left: group.start, bottom: band.end, right: group.end },
          merges: [],
        };
      }),
    );
  }
  for (const merge of sheet.merges) {
    budget.tick();
    const band = findInterval(bands, merge.top, budget);
    const group = band < 0 ? -1 : findInterval(groups[band]!, merge.left, budget);
    if (group < 0) continue;
    const region = regions[band]![group]!;
    const clipped = {
      top: merge.top,
      left: merge.left,
      bottom: Math.min(merge.bottom, region.range.bottom),
      right: Math.min(merge.right, region.range.right),
    };
    if (clipped.bottom > clipped.top || clipped.right > clipped.left)
      (region.merges as XlsxRange[]).push(clipped);
  }
  return regions.flat();
}

/** `A1:C3` for a range. */
export function rangeName(range: XlsxRange): string {
  return `${columnName(range.left)}${range.top}:${columnName(range.right)}${range.bottom}`;
}

export interface XlsxTableRows {
  rows: Cell[][];
  /** Grid cells emitted, placeholders included. */
  cells: number;
}

/**
 * The dense grid for one region, following the table convention: `rows[r][c]` is grid column `c`.
 * A merged range's top-left cell gets `rowSpan`/`colSpan` and the cells it covers become empty
 * placeholders; a merge that overlaps an earlier one is ignored. Value cells were charged to the
 * `cells` budget when the sheet was parsed; each row charges its other grid cells before it is
 * kept, and the table stops at the limit. `chargeValues` charges value cells again, for a range
 * emitted a second time (a named range or Excel table that is not one of the sheet's regions).
 * Cells in hidden rows and columns get `hidden: true` (XLS-10).
 */
export function regionRows(
  sheet: XlsxSheet,
  { range: region, merges: regionMerges }: XlsxRegion,
  budget: Budget,
  chargeValues = false,
): XlsxTableRows {
  const width = region.right - region.left + 1;
  const letters: string[] = [];
  const hiddenColumn: boolean[] = [];
  const hiddenColumns = sheet.hiddenColumns ?? [];
  for (let column = region.left; column <= region.right; column++) {
    budget.tick();
    letters.push(columnName(column));
    hiddenColumn.push(hiddenColumns.length > 0 && findInterval(hiddenColumns, column, budget) >= 0);
  }
  const merges = [...regionMerges].sort((a, b) => {
    budget.tick();
    return a.top - b.top || a.left - b.left;
  });
  const rows: Cell[][] = [];
  let emitted = 0;
  let active: XlsxRange[] = [];
  let next = 0;
  for (let row = region.top; row <= region.bottom; row++) {
    budget.tick();
    const values = sheet.rows.get(row);
    const cells: Array<Cell | undefined> = new Array<Cell | undefined>(width);
    active = active.filter((merge) => {
      budget.tick();
      return merge.bottom >= row;
    });
    for (const merge of active) {
      budget.tick();
      for (let column = merge.left; column <= merge.right; column++) {
        budget.tick();
        cells[column - region.left] = { text: '', address: `${letters[column - region.left]!}${row}` };
      }
    }
    while (next < merges.length && merges[next]!.top === row) {
      budget.tick();
      const merge = merges[next++]!;
      let free = true;
      for (let column = merge.left; column <= merge.right && free; column++) {
        budget.tick();
        free = cells[column - region.left] === undefined;
      }
      if (!free) continue;
      active.push(merge);
      const anchor = values?.get(merge.left);
      const cell: Cell = { text: anchor?.text ?? '' };
      if (anchor?.raw !== undefined) cell.raw = anchor.raw;
      if (anchor?.formula !== undefined) cell.formula = anchor.formula;
      if (merge.bottom > merge.top) cell.rowSpan = merge.bottom - merge.top + 1;
      if (merge.right > merge.left) cell.colSpan = merge.right - merge.left + 1;
      cell.address = `${letters[merge.left - region.left]!}${row}`;
      cells[merge.left - region.left] = cell;
      for (let column = merge.left + 1; column <= merge.right; column++) {
        budget.tick();
        cells[column - region.left] = { text: '', address: `${letters[column - region.left]!}${row}` };
      }
    }
    let charged = 0;
    const output: Cell[] = [];
    for (let index = 0; index < width; index++) {
      budget.tick();
      const column = region.left + index;
      const value = values?.get(column);
      if (value) charged++;
      let cell = cells[index];
      if (!cell) {
        cell = { text: value?.text ?? '' };
        if (value?.raw !== undefined) cell.raw = value.raw;
        if (value?.formula !== undefined) cell.formula = value.formula;
        cell.address = `${letters[index]!}${row}`;
      }
      output.push(cell);
    }
    if (!budget.addCells(chargeValues ? width : width - charged)) break;
    const hiddenRow = sheet.hiddenRows?.has(row) === true;
    if (hiddenRow || hiddenColumns.length > 0) {
      for (let index = 0; index < width; index++) {
        budget.tick();
        if (hiddenRow || hiddenColumn[index]) output[index]!.hidden = true;
      }
    }
    rows.push(output);
    emitted += width;
  }
  return { rows, cells: emitted };
}

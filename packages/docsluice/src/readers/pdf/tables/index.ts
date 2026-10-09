import type { Budget } from '../../../core/budget.js';
import type { LayoutLine } from '../layout/layout.js';

/** Axis-aligned rule segment supplied by the future PDF operator adapter. */
export interface RuleSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  sourceIndex: number;
}

export interface TablePage {
  width: number;
  height: number;
}

export interface TableCellCandidate {
  text: string;
  sourceIndices: readonly number[];
}

export interface TableRowCandidate {
  cells: readonly TableCellCandidate[];
}

/** Private staging result. The builder later emits TableBlock/caption/warnings. */
export interface TableCandidate {
  detection: 'ruled' | 'aligned';
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  rows: readonly TableRowCandidate[];
  /** Text-item source indices, unique and ascending; not all PDF operator indices. */
  sourceIndices: readonly number[];
}

interface ValidLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  sourceIndex: number;
  sourceIndices: readonly number[];
}

interface Interval {
  start: number;
  end: number;
}

interface Grid {
  xs: number[];
  ys: number[];
  /** Row-major occupancy of complete, fully ruled cells. */
  cells: Uint8Array;
  columns: number;
  rows: number;
}

interface CellRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
  cellCount: number;
}

interface RowGroup {
  y: number;
  sumY: number;
  lines: ValidLine[];
}

const ROUND_FACTOR = 1000;
const MAX_COORDINATE = 10_000_000;
const MAX_LINE_TEXT = 1_000_000;
const MAX_INPUT_LINES = 100_000;
const MAX_INPUT_SEGMENTS = 100_000;
const MAX_GRID_COORDINATES = 257;
const MAX_GRID_CELLS = 65_536;
const MAX_SOURCE_INDICES_PER_LINE = 1_000;
const MAX_TOTAL_SOURCE_INDICES = 200_000;
const RULE_EPSILON = 0.001;
const MIN_RULE_LENGTH = 2;
const ALIGN_TOLERANCE = 2;
const MIN_COLUMN_GAP = 8;
const MIN_UNRULED_ROWS = 3;
const MIN_TABLE_ROWS = 2;
const MIN_TABLE_COLUMNS = 2;
const RULED_CONFIDENCE = 0.72;
const ALIGNED_CONFIDENCE = 0.55;

function isReadonlyArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

function validPage(page: TablePage): boolean {
  return (
    page !== null &&
    typeof page === 'object' &&
    Number.isFinite(page.width) &&
    Number.isFinite(page.height) &&
    page.width > 0 &&
    page.height > 0 &&
    page.width <= MAX_COORDINATE &&
    page.height <= MAX_COORDINATE
  );
}

function compareNumbers(a: number, b: number, budget: Budget): number {
  budget.tick();
  return a - b;
}

function compareLines(a: ValidLine, b: ValidLine, budget: Budget): number {
  budget.tick();
  return (
    a.centerY - b.centerY ||
    a.centerX - b.centerX ||
    a.sourceIndex - b.sourceIndex ||
    (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)
  );
}

function compareLineX(a: ValidLine, b: ValidLine, budget: Budget): number {
  budget.tick();
  return a.centerX - b.centerX || a.sourceIndex - b.sourceIndex || compareLines(a, b, budget);
}

function validLines(lines: readonly LayoutLine[], budget: Budget): ValidLine[] {
  if (lines.length > MAX_INPUT_LINES) return [];
  const result: ValidLine[] = [];
  let indexCount = 0;
  for (const line of lines) {
    budget.tick();
    if (
      line === null ||
      typeof line !== 'object' ||
      typeof line.text !== 'string' ||
      line.text.length === 0 ||
      line.text.length > MAX_LINE_TEXT ||
      ![line.x, line.y, line.width, line.height, line.fontSize, line.sourceIndex].every(Number.isFinite) ||
      Math.max(Math.abs(line.x), Math.abs(line.y), line.width, line.height) > MAX_COORDINATE ||
      line.width < 0 ||
      line.height < 0 ||
      line.fontSize <= 0 ||
      line.fontSize > MAX_COORDINATE ||
      !Number.isSafeInteger(line.sourceIndex) ||
      line.sourceIndex < 0 ||
      !isReadonlyArray(line.sourceIndices) ||
      line.sourceIndices.length > MAX_SOURCE_INDICES_PER_LINE
    )
      continue;
    indexCount += line.sourceIndices.length;
    if (indexCount > MAX_TOTAL_SOURCE_INDICES) return [];
    const sourceIndices: number[] = [];
    for (const sourceIndex of line.sourceIndices) {
      budget.tick();
      if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) continue;
      sourceIndices.push(sourceIndex);
    }
    sourceIndices.sort((a, b) => {
      budget.tick();
      return a - b;
    });
    const uniqueIndices: number[] = [];
    for (const value of sourceIndices) {
      budget.tick();
      if (value !== uniqueIndices[uniqueIndices.length - 1]) uniqueIndices.push(value);
    }
    result.push({
      text: line.text,
      x: round(line.x),
      y: round(line.y),
      width: round(line.width),
      height: round(line.height),
      centerX: round(line.x + line.width / 2),
      // LayoutLine.y is its bottom edge/baseline in top-left page coordinates.
      centerY: round(line.y - line.height / 2),
      sourceIndex: line.sourceIndex,
      sourceIndices: uniqueIndices.length > 0 ? uniqueIndices : [line.sourceIndex],
    });
  }
  result.sort((a, b) => compareLines(a, b, budget));
  return result;
}

function mergedIntervals(intervals: Interval[], budget: Budget): Interval[] {
  intervals.sort((a, b) => compareNumbers(a.start, b.start, budget) || compareNumbers(a.end, b.end, budget));
  const merged: Interval[] = [];
  for (const interval of intervals) {
    budget.tick();
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end + RULE_EPSILON) {
      if (interval.end > previous.end) previous.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

function intervalCovers(intervals: readonly Interval[], start: number, end: number, budget: Budget): boolean {
  let low = 0;
  let high = intervals.length;
  while (low < high) {
    budget.tick();
    const middle = (low + high) >>> 1;
    if (intervals[middle]!.end + RULE_EPSILON < start) low = middle + 1;
    else high = middle;
  }
  const interval = intervals[low];
  return (
    interval !== undefined && interval.start <= start + RULE_EPSILON && interval.end >= end - RULE_EPSILON
  );
}

function normalizeRules(
  page: TablePage,
  segments: readonly RuleSegment[],
  budget: Budget,
):
  | { horizontal: Map<number, Interval[]>; vertical: Map<number, Interval[]>; xs: number[]; ys: number[] }
  | undefined {
  if (!isReadonlyArray(segments) || segments.length > MAX_INPUT_SEGMENTS) return undefined;
  const horizontal = new Map<number, Interval[]>();
  const vertical = new Map<number, Interval[]>();
  const add = (map: Map<number, Interval[]>, coordinate: number, start: number, end: number) => {
    const existing = map.get(coordinate);
    if (existing) existing.push({ start, end });
    else map.set(coordinate, [{ start, end }]);
  };
  for (const segment of segments) {
    budget.tick();
    if (
      segment === null ||
      typeof segment !== 'object' ||
      ![segment.x1, segment.y1, segment.x2, segment.y2, segment.sourceIndex].every(Number.isFinite) ||
      !Number.isSafeInteger(segment.sourceIndex) ||
      segment.sourceIndex < 0 ||
      Math.max(Math.abs(segment.x1), Math.abs(segment.x2), Math.abs(segment.y1), Math.abs(segment.y2)) >
        MAX_COORDINATE
    )
      continue;
    const x1 = round(segment.x1);
    const x2 = round(segment.x2);
    const y1 = round(segment.y1);
    const y2 = round(segment.y2);
    if (
      x1 < 0 ||
      x2 < 0 ||
      y1 < 0 ||
      y2 < 0 ||
      x1 > page.width ||
      x2 > page.width ||
      y1 > page.height ||
      y2 > page.height
    )
      continue;
    if (y1 === y2 && Math.abs(x2 - x1) >= MIN_RULE_LENGTH) {
      add(horizontal, y1, Math.min(x1, x2), Math.max(x1, x2));
      if (horizontal.size > MAX_GRID_COORDINATES) return undefined;
    } else if (x1 === x2 && Math.abs(y2 - y1) >= MIN_RULE_LENGTH) {
      add(vertical, x1, Math.min(y1, y2), Math.max(y1, y2));
      if (vertical.size > MAX_GRID_COORDINATES) return undefined;
    }
  }
  for (const [key, intervals] of horizontal) {
    budget.tick();
    horizontal.set(key, mergedIntervals(intervals, budget));
  }
  for (const [key, intervals] of vertical) {
    budget.tick();
    vertical.set(key, mergedIntervals(intervals, budget));
  }
  const xSet = new Set<number>();
  const ySet = new Set<number>();
  for (const [coordinate, intervals] of horizontal) {
    budget.tick();
    ySet.add(coordinate);
    for (const interval of intervals) {
      budget.tick();
      xSet.add(interval.start);
      xSet.add(interval.end);
      if (xSet.size > MAX_GRID_COORDINATES || ySet.size > MAX_GRID_COORDINATES) return undefined;
    }
  }
  for (const [coordinate, intervals] of vertical) {
    budget.tick();
    xSet.add(coordinate);
    for (const interval of intervals) {
      budget.tick();
      ySet.add(interval.start);
      ySet.add(interval.end);
      if (xSet.size > MAX_GRID_COORDINATES || ySet.size > MAX_GRID_COORDINATES) return undefined;
    }
  }
  const xs = [...xSet];
  const ys = [...ySet];
  xs.sort((a, b) => compareNumbers(a, b, budget));
  ys.sort((a, b) => compareNumbers(a, b, budget));
  if (
    xs.length < MIN_TABLE_COLUMNS + 1 ||
    ys.length < MIN_TABLE_ROWS + 1 ||
    xs.length > MAX_GRID_COORDINATES ||
    ys.length > MAX_GRID_COORDINATES ||
    (xs.length - 1) * (ys.length - 1) > MAX_GRID_CELLS
  )
    return undefined;
  return { horizontal, vertical, xs, ys };
}

function lineHasInterval(
  map: ReadonlyMap<number, readonly Interval[]>,
  coordinate: number,
  start: number,
  end: number,
  budget: Budget,
): boolean {
  const intervals = map.get(coordinate);
  return intervals !== undefined && intervalCovers(intervals, start, end, budget);
}

function cellIsComplete(
  x: number,
  y: number,
  rules: NonNullable<ReturnType<typeof normalizeRules>>,
  budget: Budget,
): boolean {
  return (
    lineHasInterval(rules.horizontal, rules.ys[y]!, rules.xs[x]!, rules.xs[x + 1]!, budget) &&
    lineHasInterval(rules.horizontal, rules.ys[y + 1]!, rules.xs[x]!, rules.xs[x + 1]!, budget) &&
    lineHasInterval(rules.vertical, rules.xs[x]!, rules.ys[y]!, rules.ys[y + 1]!, budget) &&
    lineHasInterval(rules.vertical, rules.xs[x + 1]!, rules.ys[y]!, rules.ys[y + 1]!, budget)
  );
}

function preflightCells(count: number, budget: Budget): boolean {
  const remaining = Math.max(0, budget.limits.cells - budget.cells);
  if (count > remaining) {
    budget.addCells(count);
    return false;
  }
  return true;
}

function buildGrid(rules: NonNullable<ReturnType<typeof normalizeRules>>, budget: Budget): Grid | undefined {
  const columns = rules.xs.length - 1;
  const rows = rules.ys.length - 1;
  const candidateCount = columns * rows;
  if (candidateCount > MAX_GRID_CELLS) return undefined;
  // Count complete cell geometry before allocating the row*column occupancy array.
  let completeCount = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      budget.tick();
      if (cellIsComplete(x, y, rules, budget)) completeCount += 1;
    }
  }
  if (completeCount < MIN_TABLE_ROWS * MIN_TABLE_COLUMNS || !preflightCells(completeCount, budget))
    return undefined;

  const cells = new Uint8Array(candidateCount);
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      budget.tick();
      if (cellIsComplete(x, y, rules, budget)) cells[y * columns + x] = 1;
    }
  }
  return { xs: rules.xs, ys: rules.ys, cells, columns, rows };
}

function ranges(grid: Grid, budget: Budget): CellRange[] {
  const seen = new Uint8Array(grid.cells.length);
  const found: CellRange[] = [];
  for (let index = 0; index < grid.cells.length; index += 1) {
    budget.tick();
    if (!grid.cells[index] || seen[index]) continue;
    const queue = [index];
    seen[index] = 1;
    let minRow = Math.floor(index / grid.columns);
    let maxRow = minRow;
    let minColumn = index % grid.columns;
    let maxColumn = minColumn;
    let count = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      budget.tick();
      const current = queue[cursor]!;
      const row = Math.floor(current / grid.columns);
      const column = current % grid.columns;
      count += 1;
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      const neighbors = [
        row > 0 ? current - grid.columns : -1,
        row + 1 < grid.rows ? current + grid.columns : -1,
        column > 0 ? current - 1 : -1,
        column + 1 < grid.columns ? current + 1 : -1,
      ];
      for (const neighbor of neighbors) {
        budget.tick();
        if (neighbor >= 0 && grid.cells[neighbor] && !seen[neighbor]) {
          seen[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    const height = maxRow - minRow + 1;
    const width = maxColumn - minColumn + 1;
    if (height >= MIN_TABLE_ROWS && width >= MIN_TABLE_COLUMNS && count === height * width)
      found.push({ top: minRow, bottom: maxRow, left: minColumn, right: maxColumn, cellCount: count });
  }
  found.sort((a, b) => {
    budget.tick();
    return a.top - b.top || a.left - b.left || a.bottom - b.bottom || a.right - b.right;
  });
  return found;
}

function cellForCenter(
  coordinates: readonly number[],
  value: number,
  first: number,
  last: number,
  budget: Budget,
): number {
  let low = first;
  let high = last;
  while (low + 1 < high) {
    budget.tick();
    const middle = (low + high) >>> 1;
    if (value < coordinates[middle]!) high = middle;
    else low = middle;
  }
  if (value <= coordinates[first]! || value >= coordinates[last]!) return -1;
  // Centers too close to a shared rule are ambiguous, so leave the text unassigned.
  if (
    Math.abs(value - coordinates[low]!) <= RULE_EPSILON ||
    Math.abs(value - coordinates[high]!) <= RULE_EPSILON
  )
    return -1;
  return low;
}

function cellText(lines: ValidLine[], budget: Budget): TableCellCandidate {
  lines.sort((a, b) => compareLines(a, b, budget));
  const textParts: string[] = [];
  const indices = new Set<number>();
  for (const line of lines) {
    budget.tick();
    textParts.push(line.text);
    for (const index of line.sourceIndices) {
      budget.tick();
      indices.add(index);
    }
  }
  const sourceIndices = sortedSet(indices, budget);
  return {
    text: textParts.join(' ').trim(),
    sourceIndices,
  };
}

function sortedSet(values: ReadonlySet<number>, budget: Budget): number[] {
  const result: number[] = [];
  for (const value of values) {
    budget.tick();
    result.push(value);
  }
  result.sort((a, b) => compareNumbers(a, b, budget));
  return result;
}

function hasResourceTruncatedWarning(budget: Budget): boolean {
  for (const warning of budget.warnings.warnings) {
    budget.tick();
    if (warning.code === 'TRUNCATED') return true;
  }
  return false;
}

function stageRuled(
  page: TablePage,
  lines: readonly ValidLine[],
  segments: readonly RuleSegment[],
  budget: Budget,
): TableCandidate[] {
  const rules = normalizeRules(page, segments, budget);
  if (!rules) return [];
  const grid = buildGrid(rules, budget);
  if (!grid) return [];
  const tableRanges = ranges(grid, budget);
  if (tableRanges.length === 0) return [];

  // Zero means unassigned; stored values are range index + 1.
  const rangeByCell = new Int32Array(grid.cells.length);
  const cellsByRange: ValidLine[][][] = [];
  for (let rangeIndex = 0; rangeIndex < tableRanges.length; rangeIndex += 1) {
    budget.tick();
    const range = tableRanges[rangeIndex]!;
    const rangeWidth = range.right - range.left + 1;
    const rangeCells: ValidLine[][] = [];
    for (let row = range.top; row <= range.bottom; row += 1) {
      for (let column = range.left; column <= range.right; column += 1) {
        budget.tick();
        const cellIndex = row * grid.columns + column;
        rangeByCell[cellIndex] = rangeIndex + 1;
        rangeCells.push([]);
      }
    }
    if (
      rangeCells.length !== range.cellCount ||
      rangeWidth * (range.bottom - range.top + 1) !== range.cellCount
    )
      continue;
    cellsByRange.push(rangeCells);
  }
  if (cellsByRange.length !== tableRanges.length) return [];
  // Map each line once into a candidate cell; do not rescan all lines for every cell/table.
  for (const line of lines) {
    budget.tick();
    const row = cellForCenter(grid.ys, line.centerY, 0, grid.rows, budget);
    const column = cellForCenter(grid.xs, line.centerX, 0, grid.columns, budget);
    if (row < 0 || column < 0) continue;
    const rangeIndex = rangeByCell[row * grid.columns + column]! - 1;
    if (rangeIndex < 0) continue;
    const range = tableRanges[rangeIndex]!;
    const localRow = row - range.top;
    const localColumn = column - range.left;
    const localIndex = localRow * (range.right - range.left + 1) + localColumn;
    cellsByRange[rangeIndex]![localIndex]!.push(line);
  }

  const staged: TableCandidate[] = [];
  let stagedChars = 0;
  for (let rangeIndex = 0; rangeIndex < tableRanges.length; rangeIndex += 1) {
    budget.tick();
    const range = tableRanges[rangeIndex]!;
    const cellLines = cellsByRange[rangeIndex]!;
    let textLength = 0;
    for (const cell of cellLines) {
      budget.tick();
      for (const line of cell) {
        budget.tick();
        textLength += line.text.length + 1;
      }
    }
    stagedChars += textLength;
    if (!budget.checkOutputChars(stagedChars)) return [];
    const width = range.right - range.left + 1;
    const rows: TableRowCandidate[] = [];
    const sourceIndices = new Set<number>();
    for (let row = 0; row < range.cellCount / width; row += 1) {
      budget.tick();
      const cells: TableCellCandidate[] = [];
      for (let column = 0; column < width; column += 1) {
        budget.tick();
        const cell = cellText(cellLines[row * width + column]!, budget);
        for (const sourceIndex of cell.sourceIndices) {
          budget.tick();
          sourceIndices.add(sourceIndex);
        }
        cells.push(cell);
      }
      rows.push({ cells });
    }
    const x = grid.xs[range.left]!;
    const y = grid.ys[range.top]!;
    const right = grid.xs[range.right + 1]!;
    const bottom = grid.ys[range.bottom + 1]!;
    staged.push({
      detection: 'ruled',
      x,
      y,
      width: round(right - x),
      height: round(bottom - y),
      confidence: RULED_CONFIDENCE,
      rows,
      sourceIndices: sortedSet(sourceIndices, budget),
    });
  }
  return staged;
}

function clusterRows(lines: ValidLine[], budget: Budget): RowGroup[] {
  const rows: RowGroup[] = [];
  let current: RowGroup | undefined;
  for (const line of lines) {
    budget.tick();
    const tolerance = Math.max(1, Math.min(3, line.height * 0.25));
    if (!current || Math.abs(line.centerY - current.y) > tolerance) {
      current = { y: line.centerY, sumY: line.centerY, lines: [line] };
      rows.push(current);
    } else {
      current.lines.push(line);
      current.sumY += line.centerY;
      current.y = round(current.sumY / current.lines.length);
    }
  }
  for (const row of rows) {
    budget.tick();
    row.lines.sort((a, b) => compareLineX(a, b, budget));
  }
  return rows;
}

function alignedRun(rows: readonly RowGroup[], start: number, page: TablePage, budget: Budget): number {
  const first = rows[start];
  if (!first || first.lines.length < MIN_TABLE_COLUMNS) return 0;
  const columns = first.lines.length;
  const anchors: number[] = [];
  for (const line of first.lines) {
    budget.tick();
    anchors.push(line.x);
  }
  for (let column = 1; column < columns; column += 1) {
    budget.tick();
    if (anchors[column]! - anchors[column - 1]! < Math.max(MIN_COLUMN_GAP, page.width * 0.03)) return 0;
  }
  let count = 0;
  for (let index = start; index < rows.length; index += 1) {
    budget.tick();
    const row = rows[index]!;
    if (row.lines.length !== columns) break;
    let matches = true;
    for (let column = 0; column < columns; column += 1) {
      budget.tick();
      if (Math.abs(row.lines[column]!.x - anchors[column]!) > Math.max(ALIGN_TOLERANCE, page.width * 0.005)) {
        matches = false;
        break;
      }
    }
    if (!matches) break;
    if (count > 0) {
      const previous = rows[index - 1]!;
      const delta = row.y - previous.y;
      if (delta <= 0 || delta > page.height * 0.2) break;
    }
    count += 1;
  }
  return count;
}

function stageAligned(page: TablePage, lines: ValidLine[], budget: Budget): TableCandidate[] {
  const rows = clusterRows(lines, budget);
  const candidates: Array<{ start: number; count: number; cellCount: number }> = [];
  let stagedCellCount = 0;
  for (let start = 0; start < rows.length;) {
    budget.tick();
    const count = alignedRun(rows, start, page, budget);
    if (count < MIN_UNRULED_ROWS) {
      start += Math.max(1, count);
      continue;
    }
    const columns = rows[start]!.lines.length;
    const cellCount = count * columns;
    stagedCellCount += cellCount;
    candidates.push({ start, count, cellCount });
    start += count;
  }
  if (candidates.length === 0 || !preflightCells(stagedCellCount, budget)) return [];

  const staged: TableCandidate[] = [];
  let stagedChars = 0;
  for (const candidate of candidates) {
    budget.tick();
    const tableRows: RowGroup[] = [];
    for (let index = candidate.start; index < candidate.start + candidate.count; index += 1) {
      budget.tick();
      tableRows.push(rows[index]!);
    }
    for (const row of tableRows) {
      for (const line of row.lines) {
        budget.tick();
        stagedChars += line.text.length + 1;
      }
    }
    if (!budget.checkOutputChars(stagedChars)) return [];
    const sourceIndices = new Set<number>();
    const resultRows: TableRowCandidate[] = [];
    for (const row of tableRows) {
      budget.tick();
      const cells = row.lines.map((line) => {
        budget.tick();
        for (const sourceIndex of line.sourceIndices) {
          budget.tick();
          sourceIndices.add(sourceIndex);
        }
        return { text: line.text.trim(), sourceIndices: line.sourceIndices };
      });
      resultRows.push({ cells });
    }
    let x = Number.POSITIVE_INFINITY;
    let y = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const row of tableRows) {
      for (const line of row.lines) {
        budget.tick();
        x = Math.min(x, line.x);
        y = Math.min(y, line.y - line.height);
        right = Math.max(right, line.x + line.width);
        bottom = Math.max(bottom, line.y);
      }
    }
    staged.push({
      detection: 'aligned',
      x: round(x),
      y: round(y),
      width: round(right - x),
      height: round(bottom - y),
      confidence: ALIGNED_CONFIDENCE,
      rows: resultRows,
      sourceIndices: sortedSet(sourceIndices, budget),
    });
  }
  return staged;
}

/**
 * Stage modest PDF table candidates from already positioned text lines and
 * axis-aligned rule segments. This is not a PDF parser and does not create
 * public blocks or charge successful cells/output; the later builder does so.
 */
export function stageTables(
  page: TablePage,
  inputLines: readonly LayoutLine[],
  segments: readonly RuleSegment[],
  budget: Budget,
): TableCandidate[] {
  budget.tick();
  if (
    !budget.canRead ||
    hasResourceTruncatedWarning(budget) ||
    !validPage(page) ||
    !isReadonlyArray(inputLines) ||
    !isReadonlyArray(segments)
  )
    return [];
  if (inputLines.length > MAX_INPUT_LINES || segments.length > MAX_INPUT_SEGMENTS) return [];
  const lines = validLines(inputLines, budget);
  if (segments.length > 0) {
    const ruled = stageRuled(page, lines, segments, budget);
    if (ruled.length > 0 || hasResourceTruncatedWarning(budget)) return ruled;
  }
  return stageAligned(page, lines, budget);
}

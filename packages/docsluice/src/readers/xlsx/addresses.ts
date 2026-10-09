import type { Budget } from '../../core/budget.js';

export interface CellAddress {
  row: number;
  column: number;
  address: string;
}

/** Parse a bounded Excel A1 cell reference (without a sheet name). */
export function parseCellAddress(value: string, budget: Budget): CellAddress | undefined {
  let cursor = 0;
  let column = 0;
  while (cursor < value.length) {
    budget.tick();
    const code = value.charCodeAt(cursor);
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
    if (column > 16_384) return undefined;
    cursor += 1;
  }
  if (cursor === 0 || cursor === value.length) return undefined;
  let row = 0;
  while (cursor < value.length) {
    budget.tick();
    const code = value.charCodeAt(cursor);
    if (code < 48 || code > 57) return undefined;
    row = row * 10 + code - 48;
    if (row > 1_048_576) return undefined;
    cursor += 1;
  }
  if (row < 1) return undefined;
  return { row, column, address: value };
}

/** Convert a 1-based column index into its Excel column letters. */
export function columnLetters(column: number, budget?: Budget): string {
  if (!Number.isSafeInteger(column) || column < 1 || column > 16_384) return '';
  let value = column;
  let output = '';
  while (value > 0) {
    budget?.tick();
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

/** Format an inclusive sheet range from 1-based coordinates. */
export function formatRange(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  budget?: Budget,
): string {
  const start = `${columnLetters(startColumn, budget)}${startRow}`;
  const end = `${columnLetters(endColumn, budget)}${endRow}`;
  return start === end ? start : `${start}:${end}`;
}

import type { Budget } from '../../core/budget.js';
import type { Cell } from '../../core/model.js';

/** Body rows looked at when guessing whether the first row is a header. */
const SAMPLE_ROWS = 20;

/** A number, date or boolean: a cell whose stored value is not text. */
const typed = (cell: Cell | undefined): boolean =>
  cell !== undefined && (typeof cell.raw === 'number' || typeof cell.raw === 'boolean');

/**
 * Header rows for a spreadsheet table (XLS-8). `true` and `false` force one or none. `'auto'` takes
 * the first row as a header when it is all text, at least half of its columns are labelled, and a
 * labelled column holds a number, date or boolean in one of the next 20 rows. A table of text only
 * gets no header: there is nothing to tell a label from a value.
 */
export function guessHeaderRows(rows: readonly Cell[][], mode: 'auto' | boolean, budget: Budget): number {
  if (rows.length === 0 || mode === false) return 0;
  if (mode === true) return 1;
  if (rows.length < 2) return 0;
  const first = rows[0]!;
  const labelled: number[] = [];
  for (let column = 0; column < first.length; column++) {
    budget.tick();
    const cell = first[column]!;
    if (typed(cell)) return 0;
    if (cell.text.trim().length > 0) labelled.push(column);
  }
  if (labelled.length === 0 || labelled.length * 2 < first.length) return 0;
  const end = Math.min(rows.length, SAMPLE_ROWS + 1);
  for (let row = 1; row < end; row++) {
    for (const column of labelled) {
      budget.tick();
      if (typed(rows[row]![column])) return 1;
    }
  }
  return 0;
}

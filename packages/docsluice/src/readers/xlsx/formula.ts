import type { Budget } from '../../core/budget.js';
import { columnName, MAX_COLUMN, MAX_ROW } from './spreadsheetml.js';

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Characters that continue a name, a function or a reference: letters, digits, `_`, `.`, `$`. */
function isNameCharacter(code: number): boolean {
  return isLetter(code) || isDigit(code) || code === 95 || code === 46 || code === 36;
}

/** An A1 reference at `start`: `[$]letters(1-3)[$]digits`, as written in formula text. */
function readReference(
  text: string,
  start: number,
): { end: number; column: number; row: number; fixedColumn: boolean; fixedRow: boolean } | undefined {
  let index = start;
  const fixedColumn = text.charCodeAt(index) === 36;
  if (fixedColumn) index++;
  let column = 0;
  let letters = 0;
  while (index < text.length && isLetter(text.charCodeAt(index)) && letters < 4) {
    column = column * 26 + ((text.charCodeAt(index) & 0xdf) - 64);
    letters++;
    index++;
  }
  if (letters === 0 || letters > 3 || column > MAX_COLUMN) return undefined;
  const fixedRow = text.charCodeAt(index) === 36;
  if (fixedRow) index++;
  let row = 0;
  let digits = 0;
  while (index < text.length && isDigit(text.charCodeAt(index)) && digits < 8) {
    row = row * 10 + text.charCodeAt(index) - 48;
    digits++;
    index++;
  }
  if (digits === 0 || row === 0 || row > MAX_ROW) return undefined;
  return { end: index, column, row, fixedColumn, fixedRow };
}

/**
 * The formula of a shared-formula dependent (ECMA-376 Part 1, 18.3.1.40): the master's text with
 * every relative A1 reference moved by the dependent's offset from the master. Absolute parts
 * (`$A`, `$1`) stay. Strings and quoted sheet names are copied as they are; function names
 * (`LOG10(`), sheet prefixes (`Q1!`) and longer names are not references. Whole-row and
 * whole-column references (`1:1`, `A:A`) are left unchanged. A reference moved off the grid
 * becomes `#REF!`, as in Excel. The text is never evaluated.
 */
export function shiftFormula(text: string, rowOffset: number, columnOffset: number, budget: Budget): string {
  if (rowOffset === 0 && columnOffset === 0) return text;
  let output = '';
  let index = 0;
  while (index < text.length) {
    budget.tick();
    const code = text.charCodeAt(index);
    if (code === 34 || code === 39) {
      // A string literal or a quoted sheet name; a doubled quote is an escaped quote.
      let end = index + 1;
      while (end < text.length) {
        budget.tick();
        if (text.charCodeAt(end) === code) {
          if (text.charCodeAt(end + 1) === code) end += 2;
          else break;
        } else {
          end++;
        }
      }
      output += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (!isNameCharacter(code)) {
      output += text[index];
      index++;
      continue;
    }
    // A run of name characters is either one reference or copied whole.
    let end = index;
    while (end < text.length && isNameCharacter(text.charCodeAt(end))) {
      budget.tick();
      end++;
    }
    const reference = readReference(text, index);
    const next = text.charCodeAt(end);
    const startsName = index === 0 || !isNameCharacter(text.charCodeAt(index - 1));
    if (!reference || reference.end !== end || !startsName || next === 40 || next === 33) {
      output += text.slice(index, end);
      index = end;
      continue;
    }
    const column = reference.fixedColumn ? reference.column : reference.column + columnOffset;
    const row = reference.fixedRow ? reference.row : reference.row + rowOffset;
    if (column < 1 || column > MAX_COLUMN || row < 1 || row > MAX_ROW) {
      output += '#REF!';
    } else {
      output += `${reference.fixedColumn ? '$' : ''}${columnName(column)}${reference.fixedRow ? '$' : ''}${row}`;
    }
    index = end;
  }
  return output;
}

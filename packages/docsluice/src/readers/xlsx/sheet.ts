import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { formatGeneral, formatNumber } from './numfmt.js';
import { StringItemText } from './shared-strings.js';
import type { XlsxSharedStrings } from './shared-strings.js';
import type { XlsxStyles } from './styles.js';
import {
  MAX_COLUMN,
  MAX_ROW,
  parseCellReference,
  parseIndex,
  parseRangeReference,
  SHEET_NAMESPACES,
} from './spreadsheetml.js';

const MAX_STYLE = 0xffff;

/** A cell that holds a value. Cells without a value (style only) are not stored. */
export interface XlsxCell {
  text: string;
  raw?: string | number | boolean;
}

export interface XlsxRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** Sparse sheet contents: rows by number, then cells by column (XLS-5). */
export interface XlsxSheet {
  rows: Map<number, Map<number, XlsxCell>>;
  merges: XlsxRange[];
  /** Value cells stored. */
  stored: number;
  /** Value cells seen after the cell allowance ran out. */
  skippedCells: number;
  /** Rows whose value cells were all skipped. */
  skippedRows: number;
}

export interface SheetContext extends XmlContext {
  sharedStrings: XlsxSharedStrings;
  /** Called once per workbook for a shared-string index that does not exist. */
  onBadSharedString: () => void;
  /** Number formats by cell style; absent means every cell is General. */
  styles?: XlsxStyles;
  /** `workbookPr date1904`: serial 0 is 1904-01-01 instead of 1899-12-31 (XLS-3). */
  date1904?: boolean;
}

interface OpenCell {
  row: number;
  column: number | undefined;
  type: string | undefined;
  style: number;
  value: string;
  inValue: boolean;
  inline: StringItemText | undefined;
}

/** An `xsd:double` lexical value: digits with an optional sign, point and exponent. No hex, no spaces. */
function isDecimal(value: string, budget: XmlContext['budget']): boolean {
  let digits = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) digits++;
    else if (code !== 43 && code !== 45 && code !== 46 && code !== 69 && code !== 101) return false;
  }
  return digits > 0;
}

/**
 * Parse a worksheet part (ECMA-376 Part 1, 18.3) with bounded SAX events. Only cells with a value
 * are kept, in `Map`s, so a sheet with values in A1 and Z90000 stores two cells. `dimension` is
 * ignored: the used range comes from the cells that exist. Each stored cell is charged to the
 * `cells` budget; once it is spent, the rest of the sheet is counted, not stored.
 */
export function parseWorksheet(input: Uint8Array, ctx: SheetContext): XlsxSheet {
  const sheet: XlsxSheet = { rows: new Map(), merges: [], stored: 0, skippedCells: 0, skippedRows: 0 };
  const names: Array<string | undefined> = [];
  const maxMerges = ctx.budget.limits.cells;
  let full = false;
  let row = 0;
  let column = 0;
  let rowStored = 0;
  let rowSkipped = 0;
  let cell: OpenCell | undefined;

  // A text format (a fourth section, or `@` with literals) can decorate stored text; `raw` keeps it.
  const formatText = (text: string, style: number): XlsxCell => {
    const code = ctx.styles?.formatOf(style);
    if (code === undefined) return { text };
    const shown = formatNumber(text, code, ctx.date1904, ctx.budget);
    return shown === text ? { text } : { text: shown, raw: text };
  };

  const finishCell = (open: OpenCell): void => {
    if (open.column === undefined) return;
    let value: XlsxCell | undefined;
    switch (open.type) {
      case 's': {
        if (open.value.length === 0) break;
        const index = parseIndex(open.value.trim(), Number.MAX_SAFE_INTEGER);
        const text = index === undefined ? undefined : ctx.sharedStrings.strings[index];
        if (text === undefined && !(ctx.sharedStrings.truncated && index !== undefined))
          ctx.onBadSharedString();
        value = formatText(text ?? '', open.style);
        break;
      }
      case 'inlineStr':
        if (open.inline) value = formatText(open.inline.take(), open.style);
        break;
      case 'b':
        if (open.value.length > 0) {
          const truth = open.value.trim() === '1';
          value = { text: truth ? 'TRUE' : 'FALSE', raw: truth };
        }
        break;
      case 'str':
        if (open.value.length > 0) value = formatText(open.value, open.style);
        break;
      case 'e':
      case 'd':
        if (open.value.length > 0) value = { text: open.value };
        break;
      default: {
        if (open.value.length === 0) break;
        const number = isDecimal(open.value, ctx.budget) ? Number(open.value) : Number.NaN;
        if (!Number.isFinite(number)) {
          value = { text: open.value };
          break;
        }
        const code = ctx.styles?.formatOf(open.style);
        const text =
          code === undefined ? formatGeneral(number) : formatNumber(number, code, ctx.date1904, ctx.budget);
        value = { text, raw: number };
      }
    }
    if (!value) return;
    if (full || ctx.budget.cells >= ctx.budget.limits.cells) {
      full = true;
      sheet.skippedCells++;
      rowSkipped++;
      return;
    }
    let cells = sheet.rows.get(open.row);
    if (!cells) {
      cells = new Map();
      sheet.rows.set(open.row, cells);
    }
    if (!cells.has(open.column)) {
      ctx.budget.addCells(1);
      sheet.stored++;
    }
    rowStored++;
    cells.set(open.column, value);
  };

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI !== undefined && SHEET_NAMESPACES.has(info.namespaceURI)
            ? info.localName
            : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (cell) {
          if (local === 'v' && parent === 'c') cell.inValue = true;
          else if (local === 'is' && parent === 'c') cell.inline = new StringItemText();
          else cell.inline?.open(local);
          return;
        }
        if (local === 'row' && parent === 'sheetData') {
          // Rows without `r` follow the previous row, as Excel writes them.
          row = parseIndex(attrs.get('r'), MAX_ROW) ?? row + 1;
          column = 0;
          rowStored = 0;
          rowSkipped = 0;
        } else if (local === 'c' && parent === 'row') {
          const reference = parseCellReference(attrs.get('r'));
          if (reference) {
            row = reference.row;
            column = reference.column;
          } else {
            column++;
          }
          cell = {
            row,
            column: row >= 1 && row <= MAX_ROW && column <= MAX_COLUMN ? column : undefined,
            type: attrs.get('t'),
            style: parseIndex(attrs.get('s'), MAX_STYLE) ?? 0,
            value: '',
            inValue: false,
            inline: undefined,
          };
        } else if (local === 'mergeCell' && parent === 'mergeCells') {
          const range = parseRangeReference(attrs.get('ref'));
          if (
            range &&
            (range.bottom > range.top || range.right > range.left) &&
            sheet.merges.length < maxMerges
          ) {
            sheet.merges.push(range);
          }
        }
      },
      onText(text) {
        if (!cell) return;
        if (cell.inValue) cell.value += text;
        else cell.inline?.append(text);
      },
      onClose() {
        ctx.budget.tick();
        const local = names.pop();
        const parent = names.at(-1);
        if (cell) {
          if (local === 'c' && parent === 'row') {
            finishCell(cell);
            cell = undefined;
          } else if (local === 'v' && parent === 'c') {
            cell.inValue = false;
          } else if (local !== 'is') {
            cell.inline?.close(local);
          }
          return;
        }
        if (local === 'row' && parent === 'sheetData' && rowSkipped > 0 && rowStored === 0)
          sheet.skippedRows++;
      },
    },
    ctx,
  );
  return sheet;
}

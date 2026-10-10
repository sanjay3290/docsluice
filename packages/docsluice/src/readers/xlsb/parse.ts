import type { Budget } from '../../core/budget.js';
import { rkNumber } from '../xls/biff.js';
import { builtInNumberFormat, formatGeneral, formatNumber } from '../xlsx/numfmt.js';
import type { SheetNote, XlsxNamedRange } from '../xlsx/emit.js';
import type { XlsxCell, XlsxRange, XlsxSheet } from '../xlsx/sheet.js';
import { MAX_COLUMN, MAX_ROW } from '../xlsx/spreadsheetml.js';
import type { XlsxStyles } from '../xlsx/styles.js';
import { BRT, f64, u16, u32, wideString, XlsbRecords } from './records.js';

/** More cell formats or custom number formats than this are ignored, as in the XLSX reader. */
const MAX_FORMATS = 65_536;

/** `BErr` values ([MS-XLSB] 2.5.98.2). */
const ERRORS = new Map([
  [0x00, '#NULL!'],
  [0x07, '#DIV/0!'],
  [0x0f, '#VALUE!'],
  [0x17, '#REF!'],
  [0x1d, '#NAME?'],
  [0x24, '#NUM!'],
  [0x2a, '#N/A'],
  [0x2b, '#GETTING_DATA'],
]);

export interface XlsbSheetEntry {
  name: string;
  /** Relationship id of the sheet part; `null` for a module sheet. */
  relationshipId: string | null;
  /** `ST_SheetState`: 0 visible, 1 hidden, 2 very hidden. */
  state: number;
}

/** A defined name that is one area of one sheet (XLS-9). */
export interface XlsbName {
  name: string;
  /** Index into `XlsbWorkbook.sheets`. */
  sheet: number;
  range: XlsxRange;
}

export interface XlsbWorkbook {
  sheets: XlsbSheetEntry[];
  /** `BrtName` records that refer to one area of one sheet, in file order. */
  names: XlsbName[];
  date1904: boolean;
  damaged: boolean;
}

/** `workbook.bin`: the sheets in `BrtBundleSh` order and the date system from `BrtWbProp`. */
export function parseXlsbWorkbook(bytes: Uint8Array, budget: Budget): XlsbWorkbook {
  const records = new XlsbRecords(bytes, budget);
  const workbook: XlsbWorkbook = { sheets: [], names: [], date1904: false, damaged: false };
  const externSheets: Array<{ first: number; last: number }> = [];
  const rawNames: Array<{ name: string; ixti: number; range: XlsxRange }> = [];
  for (let record = records.next(); record; record = records.next()) {
    if (record.type === BRT.ExternSheet) {
      const count = u32(record.data, 0) ?? 0;
      for (let index = 0; index < count && externSheets.length < MAX_FORMATS; index++) {
        budget.tick();
        const first = u32(record.data, 8 + index * 12);
        const last = u32(record.data, 12 + index * 12);
        if (first === undefined || last === undefined) break;
        externSheets.push({ first, last });
      }
    } else if (record.type === BRT.Name) {
      const name = definedName(record.data);
      if (name && rawNames.length < MAX_FORMATS) rawNames.push(name);
    } else if (record.type === BRT.WbProp) {
      workbook.date1904 = ((record.data[0] ?? 0) & 1) === 1;
    } else if (record.type === BRT.BundleSh) {
      const state = u32(record.data, 0);
      const relationship = wideString(record.data, 8);
      const name = relationship ? wideString(record.data, relationship.end) : undefined;
      if (state === undefined || !relationship || !name) {
        workbook.damaged = true;
        continue;
      }
      if (!budget.addEntries(1)) break;
      workbook.sheets.push({ name: name.text ?? '', relationshipId: relationship.text, state: state & 3 });
    }
  }
  if (records.damaged) workbook.damaged = true;
  for (const raw of rawNames) {
    budget.tick();
    const target = externSheets[raw.ixti];
    if (!target || target.first !== target.last || target.first >= workbook.sheets.length) continue;
    workbook.names.push({ name: raw.name, sheet: target.first, range: raw.range });
  }
  return workbook;
}

/**
 * A `BrtName` ([MS-XLSB] 2.4.687) whose formula is one 3-D area or cell reference (`PtgArea3d`,
 * `PtgRef3d`). Built-in names (print areas, filters) and function names are skipped.
 */
function definedName(data: Uint8Array): { name: string; ixti: number; range: XlsxRange } | undefined {
  const flags = u32(data, 0);
  const name = wideString(data, 9);
  if (flags === undefined || !name || !name.text || (flags & 0x22) !== 0) return undefined;
  const size = u32(data, name.end);
  const at = name.end + 4;
  if (size === undefined || at + size > data.length) return undefined;
  const ptg = data[at]!;
  const ixti = u16(data, at + 1);
  if (ixti === undefined) return undefined;
  if (size === 15 && (ptg === 0x3b || ptg === 0x5b || ptg === 0x7b)) {
    const top = u32(data, at + 3);
    const bottom = u32(data, at + 7);
    const left = u16(data, at + 11);
    const right = u16(data, at + 13);
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      return undefined;
    const range = {
      top: top + 1,
      bottom: bottom + 1,
      left: (left & 0x3fff) + 1,
      right: (right & 0x3fff) + 1,
    };
    if (range.bottom < range.top || range.right < range.left || range.bottom > MAX_ROW) return undefined;
    return { name: name.text, ixti, range };
  }
  if (size === 9 && (ptg === 0x3a || ptg === 0x5a || ptg === 0x7a)) {
    const row = u32(data, at + 3);
    const column = u16(data, at + 7);
    if (row === undefined || column === undefined || row >= MAX_ROW) return undefined;
    const cell = { top: row + 1, bottom: row + 1, left: (column & 0x3fff) + 1, right: (column & 0x3fff) + 1 };
    return { name: name.text, ixti, range: cell };
  }
  return undefined;
}

/** A comments part (`commentsN.bin`, [MS-XLSB] 2.1.7.8): each comment's cell, author and text. */
export function parseXlsbComments(bytes: Uint8Array, budget: Budget): SheetNote[] {
  const records = new XlsbRecords(bytes, budget);
  const authors: string[] = [];
  const notes: SheetNote[] = [];
  let open: { row: number; column: number; author?: string } | undefined;
  for (let record = records.next(); record; record = records.next()) {
    if (record.type === BRT.CommentAuthor) {
      if (authors.length < MAX_FORMATS) authors.push(wideString(record.data, 0)?.text ?? '');
    } else if (record.type === BRT.BeginComment) {
      const author = u32(record.data, 0);
      const row = u32(record.data, 4);
      const column = u32(record.data, 12);
      open =
        row === undefined || column === undefined || row >= MAX_ROW || column >= MAX_COLUMN
          ? undefined
          : { row: row + 1, column: column + 1 };
      const name = author === undefined ? undefined : authors[author]?.trim();
      if (open && name) open.author = name;
    } else if (record.type === BRT.CommentText && open) {
      // A RichStr: one flags byte, then the text as an XLWideString.
      const text = wideString(record.data, 1)?.text?.replaceAll('\r\n', '\n').trim();
      if (text && notes.length < budget.limits.cells) notes.push({ ...open, text });
      open = undefined;
    }
  }
  return notes;
}

/** A table part (`tableN.bin`, `BrtBeginList`): display name, range and header row count. */
export function parseXlsbTable(bytes: Uint8Array, budget: Budget): XlsxNamedRange | undefined {
  const records = new XlsbRecords(bytes, budget);
  for (let record = records.next(); record; record = records.next()) {
    if (record.type !== BRT.BeginList) continue;
    const data = record.data;
    const top = u32(data, 0);
    const bottom = u32(data, 4);
    const left = u32(data, 8);
    const right = u32(data, 12);
    const headerRows = u32(data, 24);
    const name = wideString(data, 64);
    const display = name ? wideString(data, name.end) : undefined;
    const title = display?.text ?? name?.text;
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      return undefined;
    if (!title || bottom < top || right < left || bottom >= MAX_ROW || right >= MAX_COLUMN) return undefined;
    return {
      name: title,
      range: { top: top + 1, bottom: bottom + 1, left: left + 1, right: right + 1 },
      headerRows: Math.min(headerRows ?? 1, 1_000),
    };
  }
  return undefined;
}

export interface XlsbStrings {
  strings: string[];
  damaged: boolean;
}

/** `sharedStrings.bin`: the text of each `BrtSSTItem` (a `RichStr`; runs and phonetics are skipped). */
export function parseXlsbStrings(bytes: Uint8Array, budget: Budget): XlsbStrings {
  const records = new XlsbRecords(bytes, budget);
  const result: XlsbStrings = { strings: [], damaged: false };
  for (let record = records.next(); record; record = records.next()) {
    if (record.type !== BRT.SSTItem) continue;
    const text = wideString(record.data, 1)?.text;
    if (typeof text !== 'string') {
      result.damaged = true;
      break;
    }
    if (!budget.checkOutputChars(text.length)) break;
    result.strings.push(text);
  }
  if (records.damaged) result.damaged = true;
  return result;
}

/** `styles.bin`: custom `BrtFmt` codes and the `iFmt` of each cell XF after `BrtBeginCellXFs`. */
export function parseXlsbStyles(bytes: Uint8Array, budget: Budget): XlsxStyles {
  const records = new XlsbRecords(bytes, budget);
  const custom = new Map<number, string>();
  const cellFormats: number[] = [];
  let inCellXfs = false;
  for (let record = records.next(); record; record = records.next()) {
    if (record.type === BRT.Fmt) {
      const id = u16(record.data, 0);
      const code = wideString(record.data, 2)?.text;
      if (id !== undefined && typeof code === 'string' && !custom.has(id) && custom.size < MAX_FORMATS)
        custom.set(id, code);
    } else if (record.type === BRT.BeginCellXFs) inCellXfs = true;
    else if (record.type === BRT.EndCellXFs) inCellXfs = false;
    else if (record.type === BRT.XF && inCellXfs && cellFormats.length < MAX_FORMATS) {
      cellFormats.push(u16(record.data, 2) ?? 0);
    }
  }
  return {
    formatOf(styleIndex: number): string | undefined {
      const id = cellFormats[styleIndex];
      if (id === undefined || id === 0) return undefined;
      const code = custom.get(id) ?? builtInNumberFormat(id);
      return code.length === 0 || code.toLowerCase() === 'general' ? undefined : code;
    },
  };
}

export interface XlsbSheetContext {
  budget: Budget;
  strings: XlsbStrings;
  styles: XlsxStyles;
  date1904: boolean;
}

export interface XlsbSheetResult {
  sheet: XlsxSheet;
  /** A `BrtCellIsst` index pointed past the shared strings. */
  badSharedString: boolean;
  damaged: boolean;
}

/**
 * Parse a worksheet part into the sparse sheet model the XLSX reader uses, so both formats share
 * regions, tables and limits. Formula cells give their cached value; formulas are never evaluated or
 * decoded. Rows and columns are 1-based like A1 references.
 */
export function parseXlsbSheet(bytes: Uint8Array, ctx: XlsbSheetContext): XlsbSheetResult {
  const budget = ctx.budget;
  const sheet: XlsxSheet = {
    rows: new Map(),
    merges: [],
    stored: 0,
    skippedCells: 0,
    skippedRows: 0,
    missingCachedValues: 0,
  };
  const result: XlsbSheetResult = { sheet, badSharedString: false, damaged: false };
  const records = new XlsbRecords(bytes, budget);
  const skippedRowNumbers = new Set<number>();
  const maxMerges = budget.limits.cells;
  let full = false;
  let row = -1;
  let column = -1;
  const hiddenRows = new Set<number>();
  const hiddenColumns: Array<{ start: number; end: number }> = [];

  const formatText = (text: string, style: number): XlsxCell => {
    const code = ctx.styles.formatOf(style);
    if (code === undefined) return { text };
    const shown = formatNumber(text, code, ctx.date1904, budget);
    return shown === text ? { text } : { text: shown, raw: text };
  };
  const formatValue = (value: number, style: number): XlsxCell => {
    const code = ctx.styles.formatOf(style);
    const text = code === undefined ? formatGeneral(value) : formatNumber(value, code, ctx.date1904, budget);
    return { text, raw: value };
  };
  const store = (value: XlsxCell): void => {
    if (row < 0 || row >= MAX_ROW || column < 0 || column >= MAX_COLUMN) return;
    const rowNumber = row + 1;
    if (full || budget.cells >= budget.limits.cells) {
      full = true;
      sheet.skippedCells++;
      if (!sheet.rows.has(rowNumber)) skippedRowNumbers.add(rowNumber);
      return;
    }
    let cells = sheet.rows.get(rowNumber);
    if (!cells) {
      cells = new Map();
      sheet.rows.set(rowNumber, cells);
    }
    if (!cells.has(column + 1)) {
      budget.addCells(1);
      sheet.stored++;
    }
    cells.set(column + 1, value);
  };

  for (let record = records.next(); record; record = records.next()) {
    const { type, data } = record;
    if (type === BRT.RowHdr) {
      const rw = u32(data, 0);
      if (rw === undefined) result.damaged = true;
      else row = rw;
      column = -1;
      // fDyZero: the row is hidden (XLS-10).
      if (rw !== undefined && rw < MAX_ROW && ((u16(data, 10) ?? 0) & 0x1000) !== 0) hiddenRows.add(rw + 1);
      continue;
    }
    if (type === BRT.ColInfo) {
      const first = u32(data, 0);
      const last = u32(data, 4);
      if (first !== undefined && last !== undefined && first <= last && first < MAX_COLUMN) {
        if (((u16(data, 16) ?? 0) & 1) !== 0 && hiddenColumns.length < MAX_COLUMN)
          hiddenColumns.push({ start: first + 1, end: Math.min(MAX_COLUMN, last + 1) });
      }
      continue;
    }
    if (type === BRT.MergeCell) {
      const top = u32(data, 0);
      const bottom = u32(data, 4);
      const left = u32(data, 8);
      const right = u32(data, 12);
      if (
        top !== undefined &&
        bottom !== undefined &&
        left !== undefined &&
        right !== undefined &&
        top <= bottom &&
        left <= right &&
        bottom < MAX_ROW &&
        right < MAX_COLUMN &&
        (bottom > top || right > left) &&
        sheet.merges.length < maxMerges
      ) {
        sheet.merges.push({ top: top + 1, left: left + 1, bottom: bottom + 1, right: right + 1 });
      }
      continue;
    }
    const long = type <= BRT.FmlaError;
    const short = type >= BRT.ShortBlank && type <= BRT.ShortIsst;
    if (!long && !short) continue;
    // A long cell starts with its column; a short cell is the one after the previous cell.
    let offset = 0;
    if (long) {
      const col = u32(data, 0);
      if (col === undefined) {
        result.damaged = true;
        continue;
      }
      column = col;
      offset = 4;
    } else {
      column++;
    }
    const styleWord = u32(data, offset);
    if (styleWord === undefined) {
      result.damaged = true;
      continue;
    }
    const style = styleWord & 0xff_ffff;
    const at = offset + 4;
    switch (type) {
      case BRT.CellRk:
      case BRT.ShortRk: {
        const rk = u32(data, at);
        if (rk === undefined) result.damaged = true;
        else store(formatValue(rkNumber(rk), style));
        break;
      }
      case BRT.CellReal:
      case BRT.ShortReal:
      case BRT.FmlaNum: {
        const value = f64(data, at);
        if (value === undefined) result.damaged = true;
        else if (Number.isFinite(value)) store(formatValue(value, style));
        break;
      }
      case BRT.CellBool:
      case BRT.ShortBool:
      case BRT.FmlaBool: {
        const value = data[at];
        if (value === undefined) result.damaged = true;
        else store({ text: value === 1 ? 'TRUE' : 'FALSE', raw: value === 1 });
        break;
      }
      case BRT.CellError:
      case BRT.ShortError:
      case BRT.FmlaError: {
        const value = data[at];
        if (value === undefined) result.damaged = true;
        else store({ text: ERRORS.get(value) ?? '#N/A' });
        break;
      }
      case BRT.CellSt:
      case BRT.ShortSt:
      case BRT.FmlaString: {
        const text = wideString(data, at)?.text;
        if (typeof text !== 'string') result.damaged = true;
        else store(formatText(text, style));
        break;
      }
      case BRT.CellIsst:
      case BRT.ShortIsst: {
        const index = u32(data, at);
        const text = index === undefined ? undefined : ctx.strings.strings[index];
        if (text === undefined && !(ctx.strings.damaged && index !== undefined))
          result.badSharedString = true;
        store(formatText(text ?? '', style));
        break;
      }
      default:
        // BrtCellBlank and BrtShortBlank hold formatting only.
        break;
    }
  }
  sheet.skippedRows = skippedRowNumbers.size;
  if (hiddenRows.size > 0) sheet.hiddenRows = hiddenRows;
  if (hiddenColumns.length > 0) {
    hiddenColumns.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of hiddenColumns) {
      budget.tick();
      const last = merged.at(-1);
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    sheet.hiddenColumns = merged;
  }
  if (records.damaged) result.damaged = true;
  return result;
}

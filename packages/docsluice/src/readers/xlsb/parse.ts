import type { Budget } from '../../core/budget.js';
import { rkNumber } from '../xls/biff.js';
import { builtInNumberFormat, formatGeneral, formatNumber } from '../xlsx/numfmt.js';
import type { XlsxCell, XlsxSheet } from '../xlsx/sheet.js';
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

export interface XlsbWorkbook {
  sheets: XlsbSheetEntry[];
  date1904: boolean;
  damaged: boolean;
}

/** `workbook.bin`: the sheets in `BrtBundleSh` order and the date system from `BrtWbProp`. */
export function parseXlsbWorkbook(bytes: Uint8Array, budget: Budget): XlsbWorkbook {
  const records = new XlsbRecords(bytes, budget);
  const workbook: XlsbWorkbook = { sheets: [], date1904: false, damaged: false };
  for (let record = records.next(); record; record = records.next()) {
    if (record.type === BRT.WbProp) {
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
  return workbook;
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
  if (records.damaged) result.damaged = true;
  return result;
}

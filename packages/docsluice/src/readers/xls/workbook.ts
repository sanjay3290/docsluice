import type { Budget } from '../../core/budget.js';
import { EncryptedError } from '../../core/errors.js';
import type { WarningSink } from '../../core/warnings.js';
import { builtInNumberFormat, formatGeneral, formatNumber } from '../xlsx/numfmt.js';
import type { SheetNote } from '../xlsx/emit.js';
import type { XlsxCell, XlsxRange, XlsxSheet } from '../xlsx/sheet.js';
import { ContinuedReader, RECORD, RecordReader, f64, recordString, rkNumber, u16, u32 } from './biff.js';

/** BIFF8 grid limits: 65,536 rows and 256 columns. */
const MAX_BIFF8_ROW = 65_536;
const MAX_BIFF8_COLUMN = 256;
/** More cell formats or custom number formats than this are ignored, as in the XLSX reader. */
const MAX_FORMATS = 65_536;

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

export interface XlsSheetEntry {
  name: string;
  /** Offset of the sheet's BOF record in the Workbook stream. */
  offset: number;
  hidden: boolean;
  /** `dt`: 0 worksheet, 1 macro sheet, 2 chart, 6 VBA module. */
  kind: number;
}

/** A defined name that is one area of one sheet (XLS-9). */
export interface XlsDefinedName {
  name: string;
  /** Index into `XlsWorkbook.sheets`. */
  sheet: number;
  range: XlsxRange;
}

export interface XlsWorkbook {
  sheets: XlsSheetEntry[];
  /** Defined names that refer to one area of one sheet, in file order. */
  names: XlsDefinedName[];
  strings: string[];
  /** The SST declared more strings than it held, or its data ran out. */
  stringsDamaged: boolean;
  date1904: boolean;
  /** Number format code by XF index; `undefined` means General. */
  formatOf(xf: number): string | undefined;
  /** A record length ran past the stream or the BIFF8 maximum. */
  damaged: boolean;
}

export interface XlsContext {
  budget: Budget;
  warnings: WarningSink;
}

/** The BOF record's version and substream type ([MS-XLS] 2.4.21). */
function bofInfo(data: Uint8Array): { version: number; kind: number } | undefined {
  const version = u16(data, 0);
  const kind = u16(data, 2);
  return version === undefined || kind === undefined ? undefined : { version, kind };
}

/** Records of a record followed by its `CONTINUE` records, as segments for a `ContinuedReader`. */
function withContinues(first: Uint8Array, records: RecordReader): Uint8Array[] {
  const segments = [first];
  while (records.peekType() === RECORD.CONTINUE) {
    const next = records.next();
    if (!next) break;
    segments.push(next.data);
  }
  return segments;
}

/**
 * Parse the workbook globals substream: sheets, shared strings, number formats, cell formats and the
 * date system. Throws `EncryptedError` for `FILEPASS`; returns `undefined` for a non-BIFF8 stream.
 */
export function parseGlobals(stream: Uint8Array, ctx: XlsContext): XlsWorkbook | undefined {
  const records = new RecordReader(stream, 0, ctx.budget);
  const first = records.next();
  const bof = first && first.type === RECORD.BOF ? bofInfo(first.data) : undefined;
  if (!bof || bof.version !== 0x0600 || bof.kind !== 0x0005) return undefined;
  const sheets: XlsSheetEntry[] = [];
  const strings: string[] = [];
  const customFormats = new Map<number, string>();
  const cellFormats: number[] = [];
  let date1904 = false;
  let stringsDamaged = false;
  /** EXTERNSHEET entries: the first and last sheet each `ixti` refers to. */
  const externSheets: Array<{ first: number; last: number }> = [];
  const rawNames: Array<{ name: string; ixti: number; range: XlsxRange }> = [];
  for (let record = records.next(); record && record.type !== RECORD.EOF; record = records.next()) {
    switch (record.type) {
      case RECORD.EXTERNSHEET: {
        const count = u16(record.data, 0) ?? 0;
        for (let index = 0; index < count; index++) {
          ctx.budget.tick();
          const first = u16(record.data, 4 + index * 6);
          const last = u16(record.data, 6 + index * 6);
          if (first === undefined || last === undefined) break;
          externSheets.push({ first, last });
        }
        break;
      }
      case RECORD.NAME: {
        const name = definedName(record.data);
        if (name && rawNames.length < MAX_FORMATS) rawNames.push(name);
        break;
      }
      case RECORD.FILEPASS:
        throw new EncryptedError('password-required');
      case RECORD.DATEMODE:
        date1904 = u16(record.data, 0) === 1;
        break;
      case RECORD.FORMAT: {
        const id = u16(record.data, 0);
        const code = recordString(record.data, 2, 2);
        if (id !== undefined && code && !customFormats.has(id) && customFormats.size < MAX_FORMATS)
          customFormats.set(id, code.text);
        break;
      }
      case RECORD.XF:
        if (cellFormats.length < MAX_FORMATS) cellFormats.push(u16(record.data, 2) ?? 0);
        break;
      case RECORD.BOUNDSHEET8: {
        const offset = u32(record.data, 0);
        const state = record.data[4];
        const kind = record.data[5];
        const name = recordString(record.data, 6, 1);
        if (offset === undefined || state === undefined || kind === undefined) break;
        if (!ctx.budget.addEntries(1)) break;
        sheets.push({ name: name?.text ?? '', offset, hidden: (state & 3) !== 0, kind });
        break;
      }
      case RECORD.SST: {
        const reader = new ContinuedReader(withContinues(record.data, records), ctx.budget);
        reader.u32();
        const unique = reader.u32() ?? 0;
        // The declared count is only an upper bound: reading stops when the data runs out.
        for (let index = 0; index < unique; index++) {
          ctx.budget.tick();
          const text = reader.richExtendedString();
          if (text === undefined) {
            stringsDamaged = true;
            break;
          }
          strings.push(text);
        }
        break;
      }
      default:
        break;
    }
  }
  const names: XlsDefinedName[] = [];
  for (const raw of rawNames) {
    ctx.budget.tick();
    const target = externSheets[raw.ixti];
    if (!target || target.first !== target.last || target.first >= sheets.length) continue;
    names.push({ name: raw.name, sheet: target.first, range: raw.range });
  }
  return {
    sheets,
    names,
    strings,
    stringsDamaged,
    date1904,
    damaged: records.damaged,
    formatOf(xf: number): string | undefined {
      const id = cellFormats[xf];
      if (id === undefined || id === 0) return undefined;
      const code = customFormats.get(id) ?? builtInNumberFormat(id);
      return code.length === 0 || code.toLowerCase() === 'general' ? undefined : code;
    },
  };
}

/**
 * A `NAME` (Lbl, [MS-XLS] 2.4.150) whose formula is one 3-D area or cell reference (`PtgArea3d`,
 * `PtgRef3d`). Built-in names (print areas, filters) and function names are skipped.
 */
function definedName(data: Uint8Array): { name: string; ixti: number; range: XlsxRange } | undefined {
  const flags = u16(data, 0);
  const length = data[3];
  const formulaSize = u16(data, 4);
  const wide = data[14];
  if (flags === undefined || length === undefined || formulaSize === undefined || wide === undefined)
    return undefined;
  if ((flags & 0x0022) !== 0 || length === 0) return undefined;
  const nameEnd = 15 + length * ((wide & 1) === 1 ? 2 : 1);
  if (nameEnd + formulaSize > data.length) return undefined;
  let name = '';
  for (let index = 0; index < length; index++) {
    const at = 15 + index * ((wide & 1) === 1 ? 2 : 1);
    name += String.fromCharCode((wide & 1) === 1 ? data[at]! | (data[at + 1]! << 8) : data[at]!);
  }
  const ptg = data[nameEnd]!;
  const ixti = u16(data, nameEnd + 1);
  if (ixti === undefined) return undefined;
  if (formulaSize === 11 && (ptg === 0x3b || ptg === 0x5b || ptg === 0x7b)) {
    const top = u16(data, nameEnd + 3);
    const bottom = u16(data, nameEnd + 5);
    const left = u16(data, nameEnd + 7);
    const right = u16(data, nameEnd + 9);
    if (top === undefined || bottom === undefined || left === undefined || right === undefined)
      return undefined;
    const range = {
      top: top + 1,
      bottom: bottom + 1,
      left: (left & 0x3fff) + 1,
      right: (right & 0x3fff) + 1,
    };
    if (range.bottom < range.top || range.right < range.left) return undefined;
    return { name, ixti, range };
  }
  if (formulaSize === 7 && (ptg === 0x3a || ptg === 0x5a || ptg === 0x7a)) {
    const row = u16(data, nameEnd + 3);
    const column = u16(data, nameEnd + 5);
    if (row === undefined || column === undefined) return undefined;
    const cell = { top: row + 1, bottom: row + 1, left: (column & 0x3fff) + 1, right: (column & 0x3fff) + 1 };
    return { name, ixti, range: cell };
  }
  return undefined;
}

export interface SheetResult {
  sheet: XlsxSheet;
  /** Cell comments from NOTE records with their TXO text (XLS-9). */
  comments: SheetNote[];
  /** A `LABELSST` index pointed past the shared strings. */
  badSharedString: boolean;
  damaged: boolean;
}

/**
 * Parse one worksheet substream into the sparse sheet model the XLSX reader uses, so both formats
 * share regions, tables and limits. Rows and columns are 1-based like A1 references.
 */
export function parseSheet(
  stream: Uint8Array,
  entry: XlsSheetEntry,
  workbook: XlsWorkbook,
  ctx: XlsContext,
): SheetResult {
  const sheet: XlsxSheet = {
    rows: new Map(),
    merges: [],
    stored: 0,
    skippedCells: 0,
    skippedRows: 0,
    missingCachedValues: 0,
  };
  const result: SheetResult = { sheet, comments: [], badSharedString: false, damaged: false };
  const records = new RecordReader(stream, entry.offset, ctx.budget);
  const first = records.next();
  const bof = first && first.type === RECORD.BOF ? bofInfo(first.data) : undefined;
  if (!bof || bof.version !== 0x0600 || bof.kind !== 0x0010) {
    result.damaged = true;
    return result;
  }
  let full = false;
  const skippedRowNumbers = new Set<number>();
  const hiddenRows = new Set<number>();
  const hiddenColumns: Array<{ start: number; end: number }> = [];
  /** Comment text by object id: an OBJ record of a note, then its TXO and CONTINUE records. */
  const noteText = new Map<number, string>();
  let noteObject: number | undefined;

  const formatText = (text: string, xf: number): XlsxCell => {
    const code = workbook.formatOf(xf);
    if (code === undefined) return { text };
    const shown = formatNumber(text, code, workbook.date1904, ctx.budget);
    return shown === text ? { text } : { text: shown, raw: text };
  };
  const formatValue = (value: number, xf: number): XlsxCell => {
    const code = workbook.formatOf(xf);
    const text =
      code === undefined ? formatGeneral(value) : formatNumber(value, code, workbook.date1904, ctx.budget);
    return { text, raw: value };
  };
  const store = (row: number | undefined, column: number | undefined, value: XlsxCell): void => {
    if (row === undefined || column === undefined || row >= MAX_BIFF8_ROW || column >= MAX_BIFF8_COLUMN)
      return;
    const rowNumber = row + 1;
    if (full || ctx.budget.cells >= ctx.budget.limits.cells) {
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
      ctx.budget.addCells(1);
      sheet.stored++;
    }
    cells.set(column + 1, value);
  };

  for (let record = records.next(); record && record.type !== RECORD.EOF; record = records.next()) {
    const data = record.data;
    const row = u16(data, 0);
    const column = u16(data, 2);
    const xf = u16(data, 4) ?? 0;
    switch (record.type) {
      case RECORD.LABELSST: {
        const index = u32(data, 6);
        const text = index === undefined ? undefined : workbook.strings[index];
        if (text === undefined && !(workbook.stringsDamaged && index !== undefined))
          result.badSharedString = true;
        store(row, column, formatText(text ?? '', xf));
        break;
      }
      case RECORD.LABEL:
      case RECORD.RSTRING: {
        const text = recordString(data, 6, 2);
        if (text) store(row, column, formatText(text.text, xf));
        break;
      }
      case RECORD.NUMBER: {
        const value = f64(data, 6);
        if (value !== undefined && Number.isFinite(value)) store(row, column, formatValue(value, xf));
        break;
      }
      case RECORD.RK: {
        const rk = u32(data, 6);
        if (rk !== undefined) store(row, column, formatValue(rkNumber(rk), xf));
        break;
      }
      case RECORD.MULRK: {
        // rw, colFirst, then (ixfe, RK) pairs, then colLast.
        if (row === undefined || column === undefined) break;
        const pairs = Math.floor((data.length - 6) / 6);
        for (let index = 0; index < pairs; index++) {
          ctx.budget.tick();
          const pairXf = u16(data, 4 + index * 6) ?? 0;
          const rk = u32(data, 6 + index * 6);
          if (rk !== undefined) store(row, column + index, formatValue(rkNumber(rk), pairXf));
        }
        break;
      }
      case RECORD.BOOLERR: {
        const value = data[6];
        const isError = data[7] === 1;
        if (value === undefined) break;
        if (isError) store(row, column, { text: ERRORS.get(value) ?? '#VALUE!' });
        else store(row, column, { text: value ? 'TRUE' : 'FALSE', raw: value !== 0 });
        break;
      }
      case RECORD.FORMULA: {
        // The cached result ([MS-XLS] 2.5.133): a double, or a tagged string, boolean, error or empty.
        // Formulas are never calculated, and their text is not decompiled from parsed tokens.
        const tagged = u16(data, 12) === 0xffff;
        if (!tagged) {
          const value = f64(data, 6);
          if (value !== undefined && Number.isFinite(value)) store(row, column, formatValue(value, xf));
          else sheet.missingCachedValues++;
          break;
        }
        const tag = data[6];
        if (tag === 0) {
          const next = records.peekType() === RECORD.STRING ? records.next() : undefined;
          const reader = next
            ? new ContinuedReader(withContinues(next.data, records), ctx.budget)
            : undefined;
          const length = reader?.u16();
          const flags = reader?.u8();
          const text =
            reader && length !== undefined && flags !== undefined
              ? reader.characters(length, (flags & 1) === 1)
              : undefined;
          if (text === undefined) sheet.missingCachedValues++;
          else store(row, column, formatText(text, xf));
        } else if (tag === 1) store(row, column, { text: data[8] ? 'TRUE' : 'FALSE', raw: data[8] !== 0 });
        else if (tag === 2) store(row, column, { text: ERRORS.get(data[8] ?? -1) ?? '#VALUE!' });
        else if (tag === 3) store(row, column, { text: '' });
        else sheet.missingCachedValues++;
        break;
      }
      case RECORD.MERGECELLS: {
        const count = u16(data, 0) ?? 0;
        for (let index = 0; index < count; index++) {
          ctx.budget.tick();
          const base = 2 + index * 8;
          const top = u16(data, base);
          const bottom = u16(data, base + 2);
          const left = u16(data, base + 4);
          const right = u16(data, base + 6);
          if (top === undefined || bottom === undefined || left === undefined || right === undefined) break;
          if (bottom < top || right < left || (bottom === top && right === left)) continue;
          if (bottom >= MAX_BIFF8_ROW || right >= MAX_BIFF8_COLUMN) continue;
          if (sheet.merges.length >= ctx.budget.limits.cells) break;
          sheet.merges.push({ top: top + 1, bottom: bottom + 1, left: left + 1, right: right + 1 });
        }
        break;
      }
      case RECORD.ROW:
        // fDyZero: the row is hidden (XLS-10).
        if (row !== undefined && row < MAX_BIFF8_ROW && ((u16(data, 12) ?? 0) & 0x20) !== 0)
          hiddenRows.add(row + 1);
        break;
      case RECORD.COLINFO: {
        const last = u16(data, 2);
        if (row === undefined || last === undefined || last < row || row >= MAX_BIFF8_COLUMN) break;
        if (((u16(data, 8) ?? 0) & 1) !== 0 && hiddenColumns.length < MAX_BIFF8_COLUMN)
          hiddenColumns.push({ start: row + 1, end: Math.min(MAX_BIFF8_COLUMN, last + 1) });
        break;
      }
      case RECORD.OBJ:
        // ftCmo: object type 0x19 is a comment; its id links the TXO text to a NOTE.
        noteObject = u16(data, 0) === 0x15 && u16(data, 4) === 0x19 ? u16(data, 6) : undefined;
        break;
      case RECORD.TXO: {
        const length = u16(data, 10) ?? 0;
        const segments: Uint8Array[] = [];
        while (records.peekType() === RECORD.CONTINUE) {
          ctx.budget.tick();
          const next = records.next();
          if (!next) break;
          segments.push(next.data);
        }
        if (noteObject === undefined || length === 0 || noteText.size >= MAX_FORMATS) break;
        const reader = new ContinuedReader(segments, ctx.budget);
        const flags = reader.u8();
        const text = flags === undefined ? undefined : reader.characters(length, (flags & 1) === 1);
        if (text !== undefined) noteText.set(noteObject, text);
        noteObject = undefined;
        break;
      }
      case RECORD.NOTE: {
        const text = noteText.get(u16(data, 6) ?? -1);
        if (row === undefined || column === undefined || text === undefined || text.trim().length === 0)
          break;
        const author = recordString(data, 8, 2)?.text.trim();
        const note: SheetNote = {
          row: row + 1,
          column: column + 1,
          text: text.replaceAll('\r\n', '\n').trim(),
        };
        if (author) note.author = author;
        result.comments.push(note);
        break;
      }
      default:
        break;
    }
  }
  if (hiddenRows.size > 0) sheet.hiddenRows = hiddenRows;
  if (hiddenColumns.length > 0) {
    hiddenColumns.sort((a, b) => a.start - b.start);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of hiddenColumns) {
      ctx.budget.tick();
      const last = merged.at(-1);
      if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
      else merged.push({ ...range });
    }
    sheet.hiddenColumns = merged;
  }
  sheet.skippedRows = skippedRowNumbers.size;
  result.damaged = records.damaged;
  return result;
}

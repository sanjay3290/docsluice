import { CorruptFileError, LimitExceededError } from '../../core/errors.js';
import type { Cell, Location } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { openCfb, type CfbArchive } from '../../ole/index.js';
import { builtInNumberFormat, formatNumber } from '../xlsx/numfmt.js';
import { iterateBiffRecords, type BiffRecord } from './records.js';
import { readBiff8Sst } from './sst.js';

const MIME = 'application/vnd.ms-excel';
const BOF = 0x0809;
const EOF = 0x000a;
const BOUNDSHEET8 = 0x0085;
const DATEMODE = 0x0022;
const FORMAT = 0x041e;
const XF = 0x00e0;
const SST = 0x00fc;
const CONTINUE = 0x003c;
const MERGECELLS = 0x00e5;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const BOOLERR = 0x0205;
const FORMULA = 0x0006;
const STRING = 0x0207;
const MAX_SHEETS = 4_096;
const MAX_WORKBOOK_CELLS = 100_000;
const MAX_SHEET_CELLS = 50_000;
const MAX_MERGE_RANGES = 50_000;
const MAX_TEXT_LENGTH = 32_767;

interface SheetInfo {
  offset: number;
  name: string;
  state: number;
  type: number;
  seen: boolean;
  invalidOffset: boolean;
  cells: Map<number, StoredCell>;
  merges: Map<number, { rowSpan: number; colSpan: number }>;
  duplicateWarned: boolean;
}

interface StoredCell {
  row: number;
  col: number;
  cell: Cell;
}

interface ParsedValue {
  raw: string | number | boolean;
  text: string;
  formula?: string;
}

interface TruncationStats {
  cells: number;
  rows: Set<number>;
}

interface MergeCount {
  value: number;
}

interface TableGroup {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  rows: Cell[][];
}

/** Read supported BIFF8 worksheet values from a Workbook/Book CFB stream. */
export const xlsReader: Reader = {
  id: 'xls',
  mimeTypes: [MIME],
  read(ctx) {
    return Promise.resolve().then(() => readWorkbook(ctx));
  },
};

function readWorkbook(ctx: ReadContext): void {
  const cfb = ctx.cfb ?? openCfb(ctx.bytes, ctx.budget);
  const workbookPath = findWorkbookStream(cfb, ctx);
  if (!workbookPath) throw corrupt();
  const bytes = cfb.read(workbookPath);
  const global = readGlobals(bytes, ctx);
  const sheets = global.sheets;
  if (sheets.length === 0) throw corrupt();
  const offsets = new Map<number, SheetInfo>();
  for (const sheet of sheets) {
    ctx.budget.tick();
    if (offsets.has(sheet.offset)) {
      sheet.invalidOffset = true;
      offsets.get(sheet.offset)!.invalidOffset = true;
      continue;
    }
    offsets.set(sheet.offset, sheet);
  }

  const skipped = { cells: 0, rows: new Set<number>() } satisfies TruncationStats;
  let accepting = true;
  let workbookCellCount = 0;
  let stagedOutputChars = 0;
  for (const sheet of sheets) {
    ctx.budget.tick();
    stagedOutputChars += sheet.name.length;
  }
  const mergeCount: MergeCount = { value: 0 };
  let active: SheetInfo | undefined;
  let pendingFormula: PendingFormula | undefined;
  let parsedAnySheet = false;
  let unreadableWarned = false;
  const warnUnreadable = (): void => {
    if (unreadableWarned) return;
    unreadableWarned = true;
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Some XLS worksheet data could not be read.' });
  };

  const countSkipped = (row: number, count: number): void => {
    skipped.cells += count;
    skipped.rows.add(row);
  };

  const tryStore = (sheet: SheetInfo, row: number, col: number, cell: Cell): boolean => {
    if (row < 0 || row > 65_535 || col < 0 || col > 255) throw corrupt();
    const key = row * 256 + col;
    if (sheet.cells.has(key)) {
      if (!sheet.duplicateWarned) {
        sheet.duplicateWarned = true;
        warnUnreadable();
      }
      return true;
    }
    if (sheet.cells.size >= MAX_SHEET_CELLS) throw new LimitExceededError('xlsSheetCells', MAX_SHEET_CELLS);
    if (workbookCellCount >= MAX_WORKBOOK_CELLS)
      throw new LimitExceededError('xlsWorkbookCells', MAX_WORKBOOK_CELLS);
    const formulaChars = cell.formula?.length ?? 0;
    if (!ctx.budget.checkOutputChars(stagedOutputChars + cell.text.length + formulaChars)) {
      accepting = false;
      countSkipped(row, 1);
      return false;
    }
    if (!ctx.budget.addCells(1)) {
      accepting = false;
      countSkipped(row, 1);
      return false;
    }
    if (formulaChars > 0 && !ctx.budget.addOutputChars(formulaChars)) {
      accepting = false;
      countSkipped(row, 1);
      return false;
    }
    sheet.cells.set(key, { row, col, cell });
    workbookCellCount += 1;
    stagedOutputChars += cell.text.length;
    return true;
  };

  try {
    for (const record of iterateBiffRecords(bytes, ctx.budget)) {
      ctx.budget.tick();
      const sheetAtOffset = offsets.get(record.offset);
      if (sheetAtOffset) {
        if (active) {
          if (pendingFormula) warnUnreadable();
          active = undefined;
          pendingFormula = undefined;
        }
        sheetAtOffset.seen = true;
        if (record.id !== BOF || record.data.byteLength < 4) {
          sheetAtOffset.invalidOffset = true;
          warnUnreadable();
          continue;
        }
        const subtype = readU16(record.data, 2, ctx);
        if (subtype !== 0x0010 || sheetAtOffset.type !== 0) {
          sheetAtOffset.invalidOffset = true;
          warnUnreadable();
          continue;
        }
        active = sheetAtOffset;
        pendingFormula = undefined;
        parsedAnySheet = true;
        continue;
      }
      if (!active) continue;
      if (record.id === EOF) {
        if (pendingFormula) warnUnreadable();
        active = undefined;
        pendingFormula = undefined;
        continue;
      }
      if (!accepting) {
        const row = recordRow(record, ctx);
        const cells = recordCellCount(record);
        if (row !== undefined && cells > 0) countSkipped(row, cells);
        continue;
      }
      pendingFormula = parseWorksheetRecord(
        record,
        active,
        pendingFormula,
        global,
        mergeCount,
        ctx,
        tryStore,
        warnUnreadable,
      );
      if (ctx.budget.truncated) accepting = false;
    }
  } catch (error) {
    if (error instanceof CorruptFileError && parsedAnySheet) {
      warnUnreadable();
      active = undefined;
    } else {
      throw error;
    }
  }
  if (active || sheets.some((sheet) => !sheet.seen || sheet.invalidOffset)) warnUnreadable();
  if (!parsedAnySheet) throw corrupt();

  emitSheets(sheets, ctx);
  if (skipped.cells > 0) {
    ctx.warnings.add({
      code: 'TRUNCATED',
      message: `XLS output omitted ${skipped.cells} cells across ${skipped.rows.size} rows after reaching a resource limit.`,
    });
  }
}

interface GlobalData {
  sheets: SheetInfo[];
  sharedStrings: string[];
  formats: Map<number, string>;
  xfFormatIds: number[];
  date1904: boolean;
}

function findWorkbookStream(cfb: CfbArchive, ctx: ReadContext): string | undefined {
  for (const entry of cfb.entries) {
    ctx.budget.tick();
    if (entry.type !== 'stream') continue;
    const leaf = entry.path.slice(entry.path.lastIndexOf('/') + 1).toLowerCase();
    if (leaf === 'workbook' || leaf === 'book') return entry.path;
  }
  return undefined;
}

function readGlobals(bytes: Uint8Array, ctx: ReadContext): GlobalData {
  const iterator = iterateBiffRecords(bytes, ctx.budget);
  const first = iterator.next();
  if (first.done || first.value.id !== BOF || first.value.data.byteLength < 4) throw corrupt();
  if (readU16(first.value.data, 2, ctx) !== 0x0005) throw corrupt();
  const output: GlobalData = {
    sheets: [],
    sharedStrings: [],
    formats: new Map(),
    xfFormatIds: [],
    date1904: false,
  };
  let pending: IteratorResult<BiffRecord> | undefined;
  let ended = false;
  let sstSeen = false;
  while (true) {
    ctx.budget.tick();
    const next = pending ?? iterator.next();
    pending = undefined;
    if (next.done) break;
    const record = next.value;
    if (record.id === EOF) {
      ended = true;
      break;
    }
    switch (record.id) {
      case BOUNDSHEET8:
        if (output.sheets.length >= MAX_SHEETS) throw new LimitExceededError('xlsSheets', MAX_SHEETS);
        output.sheets.push(parseBoundSheet(record.data, ctx));
        break;
      case SST: {
        if (sstSeen) throw corrupt();
        sstSeen = true;
        const continues: Uint8Array[] = [];
        while (true) {
          ctx.budget.tick();
          const continuation = iterator.next();
          if (continuation.done) {
            pending = continuation;
            break;
          }
          if (continuation.value.id !== CONTINUE) {
            pending = continuation;
            break;
          }
          if (continues.length >= 100_000) throw new LimitExceededError('xlsSstSegments', 100_000);
          continues.push(continuation.value.data);
        }
        output.sharedStrings = readBiff8Sst(record.data, continues, ctx.budget);
        break;
      }
      case FORMAT: {
        if (record.data.byteLength < 5) throw corrupt();
        const id = readU16(record.data, 0, ctx);
        const parsed = decodeUnicodeString(record.data, 2, ctx, MAX_TEXT_LENGTH);
        if (parsed.offset !== record.data.length) throw corrupt();
        output.formats.set(id, parsed.text);
        break;
      }
      case XF:
        if (record.data.byteLength < 4) throw corrupt();
        output.xfFormatIds.push(readU16(record.data, 2, ctx));
        break;
      case DATEMODE:
        requireLength(record.data, 2);
        output.date1904 = (readU16(record.data, 0, ctx) & 1) !== 0;
        break;
    }
  }
  if (!ended) throw corrupt();
  return output;
}

function parseBoundSheet(data: Uint8Array, ctx: ReadContext): SheetInfo {
  if (data.byteLength < 8) throw corrupt();
  const offset = readU32(data, 0, ctx);
  const state = data[4]!;
  const type = data[5]!;
  const length = data[6]!;
  const flags = data[7]!;
  if ((state & ~0x03) !== 0 || state > 2 || (flags & ~1) !== 0) throw corrupt();
  const width = flags & 1 ? 2 : 1;
  const byteCount = length * width;
  if (data.byteLength !== 8 + byteCount || length > 31) throw corrupt();
  const chars: string[] = [];
  for (let index = 0; index < length; index += 1) {
    ctx.budget.tick();
    const code = width === 2 ? readU16(data, 8 + index * 2, ctx) : data[8 + index]!;
    chars.push(String.fromCharCode(code));
  }
  return {
    offset,
    name: chars.join(''),
    state,
    type,
    seen: false,
    invalidOffset: false,
    cells: new Map(),
    merges: new Map(),
    duplicateWarned: false,
  };
}

interface PendingFormula {
  row: number;
  col: number;
  xf: number;
  formula?: string;
}

function parseWorksheetRecord(
  record: BiffRecord,
  sheet: SheetInfo,
  pendingFormula: PendingFormula | undefined,
  global: GlobalData,
  mergeCount: MergeCount,
  ctx: ReadContext,
  store: (sheet: SheetInfo, row: number, col: number, cell: Cell) => boolean,
  warnUnreadable: () => void,
): PendingFormula | undefined {
  if (pendingFormula && record.id !== STRING) {
    warnUnreadable();
    pendingFormula = undefined;
  }
  const data = record.data;
  switch (record.id) {
    case LABELSST: {
      requireLength(data, 10);
      const row = readU16(data, 0, ctx);
      const col = readU16(data, 2, ctx);
      const xf = readU16(data, 4, ctx);
      const stringIndex = readU32(data, 6, ctx);
      const value = global.sharedStrings[stringIndex];
      if (value === undefined) throw corrupt();
      return storeParsed(
        store,
        sheet,
        row,
        col,
        xf,
        { raw: value, text: formatString(value, xf, global, ctx) },
        ctx,
      );
    }
    case LABEL: {
      if (data.byteLength < 9) throw corrupt();
      const row = readU16(data, 0, ctx);
      const col = readU16(data, 2, ctx);
      const xf = readU16(data, 4, ctx);
      const parsed = decodeUnicodeString(data, 6, ctx, MAX_TEXT_LENGTH);
      if (parsed.offset !== data.byteLength) throw corrupt();
      return storeParsed(
        store,
        sheet,
        row,
        col,
        xf,
        { raw: parsed.text, text: formatString(parsed.text, xf, global, ctx) },
        ctx,
      );
    }
    case NUMBER:
      requireLength(data, 14);
      return storeNumeric(data, 0, 2, 4, readFloat64(data, 6, ctx), sheet, global, ctx, store);
    case RK:
      requireLength(data, 10);
      return storeNumeric(data, 0, 2, 4, decodeRk(readU32(data, 6, ctx)), sheet, global, ctx, store);
    case MULRK:
      return parseMulRk(data, sheet, global, ctx, store);
    case BOOLERR: {
      requireLength(data, 8);
      const row = readU16(data, 0, ctx);
      const col = readU16(data, 2, ctx);
      const xf = readU16(data, 4, ctx);
      const value = data[6]!;
      if (data[7] === 0) {
        const bool = value !== 0;
        return storeParsed(store, sheet, row, col, xf, { raw: bool, text: bool ? 'TRUE' : 'FALSE' }, ctx);
      }
      const error = errorText(value);
      return storeParsed(store, sheet, row, col, xf, { raw: error, text: error }, ctx);
    }
    case FORMULA:
      return parseFormula(data, global, ctx, store, sheet);
    case STRING: {
      if (!pendingFormula) {
        warnUnreadable();
        return undefined;
      }
      if (data.byteLength < 3) throw corrupt();
      const parsed = decodeUnicodeString(data, 0, ctx, MAX_TEXT_LENGTH);
      if (parsed.offset !== data.byteLength) throw corrupt();
      return storeParsed(
        store,
        sheet,
        pendingFormula.row,
        pendingFormula.col,
        pendingFormula.xf,
        {
          raw: parsed.text,
          text: formatString(parsed.text, pendingFormula.xf, global, ctx),
          ...(pendingFormula.formula ? { formula: pendingFormula.formula } : {}),
        },
        ctx,
      );
    }
    case MERGECELLS:
      parseMerges(data, sheet, ctx, warnUnreadable, mergeCount);
      return undefined;
    default:
      return undefined;
  }
}

function parseFormula(
  data: Uint8Array,
  global: GlobalData,
  ctx: ReadContext,
  store: (sheet: SheetInfo, row: number, col: number, cell: Cell) => boolean,
  sheet: SheetInfo,
): PendingFormula | undefined {
  if (data.byteLength < 22) throw corrupt();
  const row = readU16(data, 0, ctx);
  const col = readU16(data, 2, ctx);
  const xf = readU16(data, 4, ctx);
  const result = data.subarray(6, 14);
  const special = result[6] === 0xff && result[7] === 0xff;
  const formulaLength = readU16(data, 20, ctx);
  if (formulaLength > data.byteLength - 22) throw corrupt();
  const formula = ctx.options.formulas
    ? decodeFormula(data.subarray(22, 22 + formulaLength), ctx)
    : undefined;
  if (!special) {
    const value = readFloat64(data, 6, ctx);
    storeNumeric(data, 0, 2, 4, value, sheet, global, ctx, store, formula);
    return undefined;
  }
  switch (result[0]) {
    case 0:
      return { row, col, xf, ...(formula ? { formula } : {}) };
    case 1: {
      const value = result[2] !== 0;
      storeParsed(
        store,
        sheet,
        row,
        col,
        xf,
        { raw: value, text: value ? 'TRUE' : 'FALSE', ...(formula ? { formula } : {}) },
        ctx,
      );
      return undefined;
    }
    case 2: {
      const error = errorText(result[2]!);
      storeParsed(
        store,
        sheet,
        row,
        col,
        xf,
        { raw: error, text: error, ...(formula ? { formula } : {}) },
        ctx,
      );
      return undefined;
    }
    case 3:
      storeParsed(store, sheet, row, col, xf, { raw: '', text: '', ...(formula ? { formula } : {}) }, ctx);
      return undefined;
    default:
      throw corrupt();
  }
}

function storeNumeric(
  data: Uint8Array,
  rowOffset: number,
  colOffset: number,
  xfOffset: number,
  value: number,
  sheet: SheetInfo,
  global: GlobalData,
  ctx: ReadContext,
  store: (sheet: SheetInfo, row: number, col: number, cell: Cell) => boolean,
  formula?: string,
): undefined {
  const row = readU16(data, rowOffset, ctx);
  const col = readU16(data, colOffset, ctx);
  const xf = readU16(data, xfOffset, ctx);
  const format = formatForXf(xf, global);
  const text = formatNumber(value, format, global.date1904, ctx.budget);
  storeParsed(store, sheet, row, col, xf, { raw: value, text, ...(formula ? { formula } : {}) }, ctx);
  return undefined;
}

function storeParsed(
  store: (sheet: SheetInfo, row: number, col: number, cell: Cell) => boolean,
  sheet: SheetInfo,
  row: number,
  col: number,
  _xf: number,
  value: ParsedValue,
  ctx: ReadContext,
): undefined {
  const cell: Cell = {
    text: value.text,
    raw: value.raw,
    address: cellAddress(row, col, ctx),
    ...(value.formula ? { formula: value.formula } : {}),
  };
  store(sheet, row, col, cell);
  return undefined;
}

function parseMulRk(
  data: Uint8Array,
  sheet: SheetInfo,
  global: GlobalData,
  ctx: ReadContext,
  store: (sheet: SheetInfo, row: number, col: number, cell: Cell) => boolean,
): undefined {
  if (data.byteLength < 12 || (data.byteLength - 6) % 6 !== 0) throw corrupt();
  const row = readU16(data, 0, ctx);
  const firstCol = readU16(data, 2, ctx);
  const lastCol = readU16(data, data.byteLength - 2, ctx);
  const count = (data.byteLength - 6) / 6;
  if (lastCol < firstCol || lastCol - firstCol + 1 !== count) throw corrupt();
  for (let index = 0; index < count; index += 1) {
    ctx.budget.tick();
    const offset = 4 + index * 6;
    const xf = readU16(data, offset, ctx);
    const value = decodeRk(readU32(data, offset + 2, ctx));
    const cell: Cell = {
      text: formatNumber(value, formatForXf(xf, global), global.date1904, ctx.budget),
      raw: value,
      address: cellAddress(row, firstCol + index, ctx),
    };
    if (!store(sheet, row, firstCol + index, cell)) break;
  }
  return undefined;
}

function parseMerges(
  data: Uint8Array,
  sheet: SheetInfo,
  ctx: ReadContext,
  warn: () => void,
  mergeCount: MergeCount,
): void {
  if (data.byteLength < 2) throw corrupt();
  const count = readU16(data, 0, ctx);
  if (count > MAX_MERGE_RANGES || data.byteLength !== 2 + count * 8) throw corrupt();
  for (let index = 0; index < count; index += 1) {
    ctx.budget.tick();
    const offset = 2 + index * 8;
    const firstRow = readU16(data, offset, ctx);
    const lastRow = readU16(data, offset + 2, ctx);
    const firstCol = readU16(data, offset + 4, ctx);
    const lastCol = readU16(data, offset + 6, ctx);
    if (lastRow < firstRow || lastCol < firstCol || lastCol > 255) {
      warn();
      continue;
    }
    const key = firstRow * 256 + firstCol;
    if (sheet.merges.has(key)) continue;
    if (mergeCount.value >= MAX_MERGE_RANGES)
      throw new LimitExceededError('xlsMergeRanges', MAX_MERGE_RANGES);
    sheet.merges.set(key, {
      rowSpan: lastRow - firstRow + 1,
      colSpan: lastCol - firstCol + 1,
    });
    mergeCount.value += 1;
  }
}

function formatString(value: string, xf: number, global: GlobalData, ctx: ReadContext): string {
  return formatNumber(value, formatForXf(xf, global), global.date1904, ctx.budget);
}

function formatForXf(xf: number, global: GlobalData): string {
  const id = global.xfFormatIds[xf] ?? 0;
  return global.formats.get(id) ?? builtInNumberFormat(id);
}

function decodeRk(value: number): number {
  const divide100 = (value & 1) !== 0;
  const integer = (value & 2) !== 0;
  let result: number;
  if (integer) {
    result = value >> 2;
  } else {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0, true);
    view.setUint32(4, value & 0xffff_fffc, true);
    result = view.getFloat64(0, true);
  }
  const decoded = divide100 ? result / 100 : result;
  if (!Number.isFinite(decoded)) throw corrupt();
  return decoded;
}

function decodeUnicodeString(
  data: Uint8Array,
  start: number,
  ctx: ReadContext,
  maxCharacters: number,
): { text: string; offset: number } {
  if (start < 0 || data.byteLength - start < 3) throw corrupt();
  const length = readU16(data, start, ctx);
  const flags = data[start + 2]!;
  if ((flags & ~1) !== 0 || length > maxCharacters) throw corrupt();
  const width = flags & 1 ? 2 : 1;
  const bytes = length * width;
  if (bytes > data.byteLength - start - 3) throw corrupt();
  const chunks: string[] = [];
  let chunk: number[] = [];
  for (let index = 0; index < length; index += 1) {
    ctx.budget.tick();
    const code = width === 2 ? readU16(data, start + 3 + index * 2, ctx) : data[start + 3 + index]!;
    chunk.push(code);
    if (chunk.length === 4_096) {
      chunks.push(String.fromCharCode(...chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) chunks.push(String.fromCharCode(...chunk));
  return { text: chunks.join(''), offset: start + 3 + bytes };
}

function decodeFormula(tokens: Uint8Array, ctx: ReadContext): string | undefined {
  const stack: string[] = [];
  let offset = 0;
  while (offset < tokens.length) {
    ctx.budget.tick();
    const token = tokens[offset]!;
    offset += 1;
    if (token === 0x1e) {
      if (tokens.length - offset < 2) return undefined;
      stack.push(String(tokens[offset]! | (tokens[offset + 1]! << 8)));
      offset += 2;
    } else if (token === 0x1f) {
      if (tokens.length - offset < 8) return undefined;
      const value = new DataView(tokens.buffer, tokens.byteOffset + offset, 8).getFloat64(0, true);
      if (!Number.isFinite(value)) return undefined;
      stack.push(String(value));
      offset += 8;
    } else if (token === 0x17) {
      if (tokens.length - offset < 2) return undefined;
      const length = tokens[offset]!;
      const flags = tokens[offset + 1]!;
      if ((flags & ~1) !== 0) return undefined;
      const width = flags & 1 ? 2 : 1;
      offset += 2;
      if (length * width > tokens.length - offset) return undefined;
      let text = '';
      for (let index = 0; index < length; index += 1) {
        ctx.budget.tick();
        const code =
          width === 2
            ? tokens[offset + index * 2]! | (tokens[offset + index * 2 + 1]! << 8)
            : tokens[offset + index]!;
        text += String.fromCharCode(code);
      }
      stack.push(`"${text.replaceAll('"', '""')}"`);
      offset += length * width;
    } else if (token === 0x1d) {
      if (offset >= tokens.length || tokens[offset]! > 1) return undefined;
      stack.push(tokens[offset++] ? 'TRUE' : 'FALSE');
    } else if (token >= 0x03 && token <= 0x0e) {
      if (stack.length < 2) return undefined;
      const right = stack.pop()!;
      const left = stack.pop()!;
      const operator = ['+', '-', '*', '/', '^', '&', '<', '<=', '=', '>=', '>', '<>'][token - 0x03]!;
      stack.push(`(${left}${operator}${right})`);
    } else if (token >= 0x12 && token <= 0x15) {
      if (stack.length === 0) return undefined;
      const value = stack.pop()!;
      stack.push(
        token === 0x12
          ? `+${value}`
          : token === 0x13
            ? `-${value}`
            : token === 0x14
              ? `${value}%`
              : `(${value})`,
      );
    } else {
      return undefined;
    }
  }
  return stack.length === 1 ? stack[0] : undefined;
}

function recordRow(record: BiffRecord, ctx: ReadContext): number | undefined {
  if ([LABELSST, LABEL, NUMBER, RK, BOOLERR, FORMULA].includes(record.id) && record.data.byteLength >= 2)
    return readU16(record.data, 0, ctx);
  if (record.id === MULRK && record.data.byteLength >= 2) return readU16(record.data, 0, ctx);
  return undefined;
}

function recordCellCount(record: BiffRecord): number {
  if ([LABELSST, LABEL, NUMBER, RK, BOOLERR, FORMULA].includes(record.id)) return 1;
  if (record.id === MULRK && record.data.byteLength >= 6 && (record.data.byteLength - 6) % 6 === 0)
    return (record.data.byteLength - 6) / 6;
  return 0;
}

function emitSheets(sheets: SheetInfo[], ctx: ReadContext): void {
  for (const sheet of sheets) {
    ctx.budget.tick();
    const location: Location = { ...(ctx.path ? { path: ctx.path } : {}), sheet: sheet.name };
    const hidden = sheet.state === 2 ? 'very' : sheet.state === 1 ? true : undefined;
    const opened = ctx.out.openSection('sheet', location, sheet.name, hidden ? { hidden } : undefined);
    try {
      if (hidden) {
        ctx.warnings.add({ code: 'HIDDEN_CONTENT', message: 'The workbook contains hidden sheets.' });
      }
      if (!opened) continue;
      if (sheet.type !== 0 || !sheet.seen || sheet.invalidOffset) continue;
      const cells = [...sheet.cells.values()];
      cells.sort((left, right) => {
        ctx.budget.tick();
        return left.row - right.row || left.col - right.col;
      });
      const groups: TableGroup[] = [];
      let active = new Map<string, TableGroup>();
      let index = 0;
      while (index < cells.length) {
        ctx.budget.tick();
        const row = cells[index]!.row;
        const nextActive = new Map<string, TableGroup>();
        while (index < cells.length && cells[index]!.row === row) {
          const runStart = index;
          let runEnd = index + 1;
          while (
            runEnd < cells.length &&
            cells[runEnd]!.row === row &&
            cells[runEnd]!.col === cells[runEnd - 1]!.col + 1
          ) {
            ctx.budget.tick();
            runEnd += 1;
          }
          const run = cells.slice(runStart, runEnd);
          for (const item of run) {
            const span = sheet.merges.get(item.row * 256 + item.col);
            if (span) {
              if (span.rowSpan > 1) item.cell.rowSpan = span.rowSpan;
              if (span.colSpan > 1) item.cell.colSpan = span.colSpan;
            }
          }
          const startCol = run[0]!.col;
          const endCol = run.at(-1)!.col;
          const key = `${startCol}:${endCol}`;
          let group = active.get(key);
          if (group && group.endRow === row - 1) {
            group.endRow = row;
            group.rows.push(run.map((item) => item.cell));
          } else {
            group = {
              startRow: row,
              endRow: row,
              startCol,
              endCol,
              rows: [run.map((item) => item.cell)],
            };
            groups.push(group);
          }
          nextActive.set(key, group);
          index = runEnd;
        }
        active = nextActive;
      }
      for (const group of groups) {
        ctx.budget.tick();
        const firstAddress = cellAddress(group.startRow, group.startCol, ctx);
        const lastAddress = cellAddress(group.endRow, group.endCol, ctx);
        ctx.out.table(group.rows, 0, {
          ...location,
          range: firstAddress === lastAddress ? firstAddress : `${firstAddress}:${lastAddress}`,
        });
        if (ctx.budget.truncated) break;
      }
    } finally {
      ctx.out.closeSection();
    }
    if (ctx.budget.truncated) break;
  }
}

function cellAddress(row: number, col: number, ctx: ReadContext): string {
  if (row < 0 || row > 65_535 || col < 0 || col > 255) throw corrupt();
  let index = col + 1;
  let letters = '';
  while (index > 0) {
    ctx.budget.tick();
    index -= 1;
    letters = String.fromCharCode(65 + (index % 26)) + letters;
    index = Math.floor(index / 26);
  }
  return `${letters}${row + 1}`;
}

function errorText(code: number): string {
  switch (code) {
    case 0x00:
      return '#NULL!';
    case 0x07:
      return '#DIV/0!';
    case 0x0f:
      return '#VALUE!';
    case 0x17:
      return '#REF!';
    case 0x1d:
      return '#NAME?';
    case 0x24:
      return '#NUM!';
    case 0x2a:
      return '#N/A';
    default:
      return '#ERROR!';
  }
}

function requireLength(data: Uint8Array, expected: number): void {
  if (data.byteLength !== expected) throw corrupt();
}

function readU16(data: Uint8Array, offset: number, ctx: ReadContext): number {
  ctx.budget.tick();
  if (offset < 0 || data.byteLength - offset < 2) throw corrupt();
  return new DataView(data.buffer, data.byteOffset + offset, 2).getUint16(0, true);
}

function readU32(data: Uint8Array, offset: number, ctx: ReadContext): number {
  ctx.budget.tick();
  if (offset < 0 || data.byteLength - offset < 4) throw corrupt();
  return new DataView(data.buffer, data.byteOffset + offset, 4).getUint32(0, true);
}

function readFloat64(data: Uint8Array, offset: number, ctx: ReadContext): number {
  ctx.budget.tick();
  if (offset < 0 || data.byteLength - offset < 8) throw corrupt();
  const value = new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, true);
  if (!Number.isFinite(value)) throw corrupt();
  return value;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The XLS workbook data is corrupt.');
}

import type { Cell } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { CorruptFileError, LimitExceededError } from '../../core/errors.js';
import { formatNumber, builtInNumberFormat } from '../xlsx/numfmt.js';
import { OoxmlParts, readProperties, readRelationships, scanFeatures } from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import type { XmlContext } from '../../xml/index.js';
import { openZip } from '../../zip/index.js';
import { XlsbCursor, iterXlsbRecords } from './records.js';
import type { XlsbRecord } from './records.js';

const MIME = 'application/vnd.ms-excel.sheet.binary.macroEnabled.12';
const TYPE = {
  rowHeader: 0,
  cellBlank: 1,
  cellRk: 2,
  cellError: 3,
  cellBool: 4,
  cellReal: 5,
  cellString: 6,
  cellSharedString: 7,
  formulaString: 8,
  formulaNum: 9,
  formulaBool: 10,
  formulaError: 11,
  sharedStringItem: 19,
  columnInfo: 60,
  beginSheet: 129,
  endSheet: 130,
  beginBook: 131,
  endBook: 132,
  beginBundleSheets: 143,
  endBundleSheets: 144,
  beginSheetData: 145,
  endSheetData: 146,
  workbookProperties: 153,
  bundleSheet: 156,
  beginSharedStrings: 159,
  endSharedStrings: 160,
  beginMerges: 177,
  endMerges: 178,
  mergeCell: 176,
  beginFormats: 87,
  format: 44,
  endFormats: 616,
  beginCellStyleXfs: 626,
  endCellStyleXfs: 627,
  beginCellXfs: 617,
  endCellXfs: 618,
  xf: 47,
};

const MAX_SHEETS = 100_000;
const MAX_CELLS = 1_000_000;
const MAX_SHARED_STRINGS = 100_000;
const MAX_STYLES = 65_430;
const MAX_CUMULATIVE_SOURCE_TEXT = 20_000_000;
const MAX_MERGES = 100_000;
const MIN_NORMAL_XNUM = 2.2250738585072014e-308;
const REL_OFFICE_DOCUMENT = '/officeDocument';
const REL_WORKSHEET = '/worksheet';
const REL_SHARED_STRINGS = '/sharedStrings';
const REL_STYLES = '/styles';

export interface XlsbSheetInfo {
  readonly name: string;
  readonly state: 'visible' | 'hidden' | 'very';
  readonly part: string;
}

export interface XlsbParsedCell extends Cell {
  readonly row: number;
  readonly column: number;
}

export interface XlsbParsedTable {
  readonly rows: Cell[][];
  readonly range: string;
}

export interface XlsbParsedSheet extends XlsbSheetInfo {
  readonly cells: Map<number, Map<number, XlsbParsedCell>>;
  readonly tables: XlsbParsedTable[];
}

/** Intermediate XLSB parse result, retaining sheet visibility for later adapter integration. */
export interface XlsbWorkbook {
  readonly workbookPart: string;
  readonly date1904: boolean;
  readonly sheets: XlsbParsedSheet[];
}

export const xlsbReader: Reader = {
  id: 'xlsb',
  mimeTypes: [MIME],
  async read(ctx): Promise<void> {
    const workbook = await parseXlsb(ctx);
    emitWorkbook(workbook, ctx);
  },
};

/** Parse a bounded XLSB package into sparse sheets and cached cell values. */
export async function parseXlsb(ctx: ReadContext): Promise<XlsbWorkbook> {
  ctx.budget.tick();
  const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
  const xmlContext = xmlCtx(ctx);
  const parts = new OoxmlParts(archive, xmlContext);
  const features = await scanFeatures(parts, archive, xmlContext);
  if (features.hasMacros) ctx.out.setFeature('hasMacros');
  if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
  if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
  if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
  if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');
  const rootRels = await readRelationships(parts, '', xmlContext);
  const officeRel = firstRelationship(rootRels, REL_OFFICE_DOCUMENT);
  if (!officeRel?.part) throw corruptWorkbook();

  const workbookBytes = await parts.read(officeRel.part);
  if (!workbookBytes) throw corruptWorkbook();
  const workbookResult = parseWorkbook(workbookBytes, ctx);
  const workbookRels = await readRelationships(parts, officeRel.part, xmlContext);
  const linkedSheets = linkWorkbookSheets(workbookResult.sheets, workbookRels, ctx);
  const sharedStringsRel = firstRelationship(workbookRels, REL_SHARED_STRINGS);
  const stylesRel = firstRelationship(workbookRels, REL_STYLES);
  const sharedBytes = sharedStringsRel?.part ? await parts.read(sharedStringsRel.part) : undefined;
  const styleBytes = stylesRel?.part ? await parts.read(stylesRel.part) : undefined;
  const sharedStrings = sharedBytes ? parseSharedStrings(sharedBytes, ctx) : [];
  const styles = styleBytes ? parseStyles(styleBytes, ctx) : emptyStyles();
  const properties = await readProperties(parts, xmlContext, ctx.options.metadata);
  ctx.out.setMetadata(properties);

  const output: XlsbParsedSheet[] = [];
  const cellState = { count: 0, text: 0 };
  for (const sheet of linkedSheets) {
    ctx.budget.tick();
    if (sheet.relationshipType !== REL_WORKSHEET) {
      warn(ctx, 'A workbook sheet relationship is not a worksheet part.', partLocation(ctx.path, sheet.part));
      continue;
    }
    const sheetBytes = await parts.read(sheet.part);
    if (!sheetBytes) continue;
    const parsed = parseWorksheet(
      sheetBytes,
      sharedStrings,
      styles,
      workbookResult.date1904,
      ctx,
      sheet.part,
      cellState,
    );
    output.push({
      name: sheet.name,
      state: sheet.state,
      part: sheet.part,
      cells: parsed.cells,
      tables: compactTables(parsed.cells, ctx),
    });
  }
  return { workbookPart: officeRel.part, date1904: workbookResult.date1904, sheets: output };
}

interface WorkbookSheetRecord extends XlsbSheetInfo {
  readonly relationshipId: string;
  readonly relationshipType: string;
}

interface WorkbookPartsResult {
  date1904: boolean;
  sheets: WorkbookSheetRecord[];
}

function parseWorkbook(bytes: Uint8Array, ctx: ReadContext): WorkbookPartsResult {
  let date1904 = false;
  const sheets: Array<Omit<WorkbookSheetRecord, 'part' | 'relationshipType'>> = [];
  let inBundleSheets = false;
  let sawWorkbookEnvelope = false;
  let sawEndWorkbook = false;
  const names = new Set<string>();
  const ids = new Set<number>();
  try {
    for (const record of iterXlsbRecords(bytes, ctx.budget)) {
      ctx.budget.tick();
      if (record.type === TYPE.beginBook) sawWorkbookEnvelope = true;
      else if (record.type === TYPE.endBook) sawEndWorkbook = true;
      else if (record.type === TYPE.workbookProperties) {
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const flags = cursor.readU32();
        date1904 = (flags & 1) !== 0;
        cursor.readU32();
        cursor.readWideString();
        if (cursor.remaining !== 0) throw new CorruptFileError();
      } else if (record.type === TYPE.beginBundleSheets) inBundleSheets = true;
      else if (record.type === TYPE.endBundleSheets) inBundleSheets = false;
      else if (record.type === TYPE.bundleSheet && inBundleSheets) {
        if (sheets.length >= MAX_SHEETS) throw new LimitExceededError('xlsbSheetCount', MAX_SHEETS);
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const stateId = cursor.readU32();
        const tabId = cursor.readU32();
        const relationshipId = cursor.readWideString();
        const name = cursor.readWideString();
        if (
          cursor.remaining !== 0 ||
          stateId > 2 ||
          tabId < 1 ||
          tabId > 0xffff ||
          !name ||
          name.length > 31
        ) {
          warn(ctx, 'The workbook contains an invalid sheet descriptor.');
          continue;
        }
        const foldedName = asciiFold(name, ctx);
        if (names.has(foldedName) || ids.has(tabId)) {
          warn(ctx, 'The workbook contains duplicate sheet identifiers.');
          continue;
        }
        names.add(foldedName);
        ids.add(tabId);
        sheets.push({
          name,
          state: stateId === 2 ? 'very' : stateId === 1 ? 'hidden' : 'visible',
          relationshipId,
        });
      }
    }
  } catch (error) {
    if (error instanceof CorruptFileError) throw corruptWorkbook();
    throw error;
  }
  if (!sawWorkbookEnvelope || !sawEndWorkbook) throw corruptWorkbook();
  return { date1904, sheets: sheets as WorkbookSheetRecord[] };
}

function linkWorkbookSheets(
  sheets: WorkbookSheetRecord[],
  relationships: Map<string, OoxmlRelationship>,
  ctx: ReadContext,
): WorkbookSheetRecord[] {
  const linked: WorkbookSheetRecord[] = [];
  for (const sheet of sheets) {
    ctx.budget.tick();
    const relationship = relationships.get(sheet.relationshipId);
    if (!relationship?.part) {
      warn(ctx, 'A workbook sheet relationship could not be resolved.');
      continue;
    }
    linked.push({
      ...sheet,
      part: relationship.part,
      relationshipType: lastRelationSegment(relationship.type),
    });
  }
  return linked;
}

interface Styles {
  readonly formats: Map<number, string>;
  readonly styleXfs: Array<{ parent: number; numFmtId: number; attributes: number }>;
  readonly cellXfs: Array<{ parent: number; numFmtId: number; attributes: number }>;
}

function emptyStyles(): Styles {
  return { formats: new Map(), styleXfs: [], cellXfs: [] };
}

function parseStyles(bytes: Uint8Array, ctx: ReadContext): Styles {
  const output = emptyStyles();
  let active: 'formats' | 'styleXfs' | 'cellXfs' | undefined;
  let announced = 0;
  let warned = false;
  try {
    for (const record of iterXlsbRecords(bytes, ctx.budget)) {
      ctx.budget.tick();
      if (record.type === TYPE.beginFormats) {
        active = 'formats';
        announced = readU32Payload(record, ctx);
      } else if (record.type === TYPE.endFormats) active = undefined;
      else if (record.type === TYPE.beginCellStyleXfs) {
        active = 'styleXfs';
        announced = readU32Payload(record, ctx);
      } else if (record.type === TYPE.endCellStyleXfs) active = undefined;
      else if (record.type === TYPE.beginCellXfs) {
        active = 'cellXfs';
        announced = readU32Payload(record, ctx);
      } else if (record.type === TYPE.endCellXfs) active = undefined;
      else if (record.type === TYPE.format && active === 'formats') {
        if (output.formats.size >= MAX_STYLES)
          throw new LimitExceededError('xlsbCustomFormatCount', MAX_STYLES);
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const numFmtId = cursor.readU16();
        const code = cursor.readWideString();
        if (cursor.remaining !== 0 || code.length === 0 || code.length > 255) {
          warned = true;
          continue;
        }
        output.formats.set(numFmtId, code);
      } else if (record.type === TYPE.xf && (active === 'styleXfs' || active === 'cellXfs')) {
        const target = active === 'styleXfs' ? output.styleXfs : output.cellXfs;
        if (target.length >= MAX_STYLES) throw new LimitExceededError('xlsbStyleCount', MAX_STYLES);
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const parent = cursor.readU16();
        const numFmtId = cursor.readU16();
        consume(cursor, 10);
        const attributes = cursor.readU16();
        if (cursor.remaining !== 0) {
          warned = true;
          continue;
        }
        target.push({ parent, numFmtId, attributes });
      }
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    warned = true;
  }
  if ((announced > 0 && output.cellXfs.length > announced) || output.cellXfs.length > MAX_STYLES || warned)
    warn(ctx, 'The XLSB styles part contained unsupported or malformed records.');
  return output;
}

function resolveFormat(styles: Styles, styleIndex: number, ctx: ReadContext, warned: Set<string>): string {
  const cellXf = styles.cellXfs[styleIndex];
  if (!cellXf) {
    warnOnce(ctx, warned, 'style-index', 'A cell style index could not be resolved.');
    return 'General';
  }
  let numFmtId = cellXf.numFmtId;
  if ((cellXf.attributes & 1) === 0 && cellXf.parent !== 0xffff) {
    const base = styles.styleXfs[cellXf.parent];
    if (base) numFmtId = base.numFmtId;
    else warnOnce(ctx, warned, 'style-parent', 'A cell style parent could not be resolved.');
  }
  return styles.formats.get(numFmtId) ?? builtInNumberFormat(numFmtId);
}

function parseSharedStrings(bytes: Uint8Array, ctx: ReadContext): string[] {
  const output: string[] = [];
  let totalCharacters = 0;
  let inCollection = false;
  let announcedUnique = 0;
  let warned = false;
  try {
    for (const record of iterXlsbRecords(bytes, ctx.budget)) {
      ctx.budget.tick();
      if (record.type === TYPE.beginSharedStrings) {
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const total = cursor.readU32();
        announcedUnique = cursor.readU32();
        if (announcedUnique > total) warned = true;
        inCollection = true;
      } else if (record.type === TYPE.endSharedStrings) inCollection = false;
      else if (record.type === TYPE.sharedStringItem && inCollection) {
        if (output.length >= MAX_SHARED_STRINGS)
          throw new LimitExceededError('xlsbSharedStringCount', MAX_SHARED_STRINGS);
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const flags = cursor.readU8();
        const value = cursor.readWideString();
        if (value.length > 0x7fff) {
          warned = true;
          continue;
        }
        if ((flags & 1) !== 0) {
          const runs = cursor.readU32();
          if (runs > 0x7fff) throw new CorruptFileError();
          consume(cursor, runs * 4);
        }
        if ((flags & 2) !== 0) {
          cursor.readWideString();
          const phoneticRuns = cursor.readU32();
          if (phoneticRuns > 0x7fff) throw new CorruptFileError();
          consume(cursor, phoneticRuns * 10);
        }
        if (cursor.remaining !== 0 || totalCharacters + value.length > MAX_CUMULATIVE_SOURCE_TEXT) {
          warned = true;
          continue;
        }
        totalCharacters += value.length;
        output.push(value);
      }
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    warned = true;
  }
  if ((announcedUnique > 0 && announcedUnique !== output.length) || warned)
    warn(ctx, 'The XLSB shared strings part contained unsupported or malformed records.');
  return output;
}

interface ParsedWorksheet {
  cells: Map<number, Map<number, XlsbParsedCell>>;
}

interface ColumnSpan {
  first: number;
  last: number;
}

interface MergeRange {
  firstRow: number;
  lastRow: number;
  firstColumn: number;
  lastColumn: number;
}

function parseWorksheet(
  bytes: Uint8Array,
  sharedStrings: readonly string[],
  styles: Styles,
  date1904: boolean,
  ctx: ReadContext,
  part: string,
  cellState: { count: number; text: number },
): ParsedWorksheet {
  const cells = new Map<number, Map<number, XlsbParsedCell>>();
  const rowHidden = new Set<number>();
  const hiddenColumns: ColumnSpan[] = [];
  const merges: MergeRange[] = [];
  const warned = new Set<string>();
  let currentRow = -1;
  let inSheetData = false;
  let stopped = false;
  try {
    for (const record of iterXlsbRecords(bytes, ctx.budget)) {
      ctx.budget.tick();
      if (record.type === TYPE.beginSheetData) {
        inSheetData = true;
        continue;
      }
      if (record.type === TYPE.endSheetData) {
        inSheetData = false;
        continue;
      }
      if (record.type === TYPE.columnInfo) {
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const first = cursor.readU32();
        const last = cursor.readU32();
        cursor.readU32();
        cursor.readU32();
        const flags = cursor.readU16();
        if (cursor.remaining !== 0 || first > last || last >= 16_384) {
          warnOnce(
            ctx,
            warned,
            'column-info',
            'A worksheet column descriptor was invalid.',
            partLocation(ctx.path, part),
          );
        } else if ((flags & 1) !== 0) {
          hiddenColumns.push({ first, last });
        }
        continue;
      }
      if (record.type === TYPE.beginMerges) continue;
      if (record.type === TYPE.endMerges) continue;
      if (record.type === TYPE.mergeCell) {
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const merge = {
          firstRow: cursor.readU32(),
          lastRow: cursor.readU32(),
          firstColumn: cursor.readU32(),
          lastColumn: cursor.readU32(),
        };
        if (
          cursor.remaining !== 0 ||
          merge.firstRow > merge.lastRow ||
          merge.firstColumn > merge.lastColumn ||
          merge.lastRow >= 1_048_576 ||
          merge.lastColumn >= 16_384
        ) {
          warnOnce(
            ctx,
            warned,
            'merge-range',
            'A worksheet merge range was invalid.',
            partLocation(ctx.path, part),
          );
        } else if (merges.length < MAX_MERGES) merges.push(merge);
        else
          warnOnce(
            ctx,
            warned,
            'merge-limit',
            'A worksheet merge range count exceeded the bounded reader capacity.',
            partLocation(ctx.path, part),
          );
        continue;
      }
      if (record.type === TYPE.rowHeader && inSheetData) {
        const cursor = new XlsbCursor(record.data, ctx.budget);
        const row = cursor.readU32();
        cursor.readU32();
        cursor.readU16();
        cursor.readU8();
        const flags = cursor.readU8();
        cursor.readU8();
        const spanCount = cursor.readU32();
        if (row >= 1_048_576 || row <= currentRow || spanCount > 16) {
          throw new CorruptFileError();
        }
        consume(cursor, spanCount * 8);
        if (cursor.remaining !== 0) throw new CorruptFileError();
        currentRow = row;
        if ((flags & 0x10) !== 0) rowHidden.add(row);
        continue;
      }
      if (!inSheetData || currentRow < 0 || record.type < TYPE.cellBlank || record.type > TYPE.formulaError)
        continue;
      const parsed = parseCell(record, currentRow, sharedStrings, styles, date1904, ctx, warned, part);
      if (!parsed) continue;
      const hidden = rowHidden.has(parsed.row) || isHiddenColumn(parsed.column, hiddenColumns, ctx);
      if (hidden) parsed.hidden = true;
      const existingRow = cells.get(parsed.row);
      if (existingRow?.has(parsed.column)) {
        warnOnce(
          ctx,
          warned,
          'duplicate-cell',
          'A worksheet contained duplicate cell addresses.',
          partLocation(ctx.path, part),
        );
        continue;
      }
      if (parsed.text.length > 0) {
        if (
          cellState.text + parsed.text.length > MAX_CUMULATIVE_SOURCE_TEXT ||
          !ctx.budget.checkOutputChars(parsed.text.length)
        ) {
          stopped = true;
          break;
        }
      }
      if (!ctx.budget.addCells(1)) {
        stopped = true;
        break;
      }
      if (cellState.count >= MAX_CELLS) throw new LimitExceededError('xlsbCellCount', MAX_CELLS);
      cellState.text += parsed.text.length;
      const rowCells = existingRow ?? new Map<number, XlsbParsedCell>();
      rowCells.set(parsed.column, parsed);
      if (!existingRow) cells.set(parsed.row, rowCells);
      cellState.count += 1;
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    if (cells.size === 0) throw new CorruptFileError('The XLSB worksheet data is invalid.');
    warn(ctx, 'The XLSB worksheet contained unreadable cell data.', partLocation(ctx.path, part));
  }
  if (stopped)
    warn(
      ctx,
      'The XLSB worksheet was truncated at a configured or defensive limit.',
      partLocation(ctx.path, part),
    );
  applyMerges(merges, cells, ctx);
  return { cells };
}

function parseCell(
  record: XlsbRecord,
  row: number,
  sharedStrings: readonly string[],
  styles: Styles,
  date1904: boolean,
  ctx: ReadContext,
  warned: Set<string>,
  part: string,
): XlsbParsedCell | undefined {
  const cursor = new XlsbCursor(record.data, ctx.budget);
  const column = cursor.readU32();
  const styleFlags = cursor.readU32();
  const styleIndex = styleFlags & 0x00ff_ffff;
  if (column >= 16_384) throw new CorruptFileError();
  let raw: string | number | boolean | null;
  let numeric = false;
  switch (record.type) {
    case TYPE.cellBlank:
      if (cursor.remaining !== 0) throw new CorruptFileError();
      raw = null;
      break;
    case TYPE.cellRk:
      raw = readRk(cursor.readU32());
      numeric = true;
      break;
    case TYPE.cellError:
    case TYPE.formulaError:
      raw = errorValue(cursor.readU8());
      break;
    case TYPE.cellBool:
    case TYPE.formulaBool: {
      const value = cursor.readU8();
      if (value > 1) throw new CorruptFileError();
      raw = value === 1;
      break;
    }
    case TYPE.cellReal:
    case TYPE.formulaNum:
      raw = cursor.readF64();
      numeric = true;
      break;
    case TYPE.cellString:
    case TYPE.formulaString:
      raw = cursor.readWideString();
      break;
    case TYPE.cellSharedString: {
      const index = cursor.readU32();
      const value = sharedStrings[index];
      if (value === undefined) {
        warnOnce(
          ctx,
          warned,
          'shared-string-index',
          'A shared string index could not be resolved.',
          partLocation(ctx.path, part),
        );
        return undefined;
      }
      raw = value;
      break;
    }
    default:
      return undefined;
  }
  if (record.type >= TYPE.formulaString && record.type <= TYPE.formulaError) {
    if (ctx.options.formulas)
      warnOnce(
        ctx,
        warned,
        'formula-text',
        'Formula text is not supported by this XLSB reader.',
        partLocation(ctx.path, part),
      );
    skipFormula(cursor);
  }
  if (cursor.remaining !== 0) throw new CorruptFileError();
  const formatCode = numeric ? resolveFormat(styles, styleIndex, ctx, warned) : 'General';
  const text =
    typeof raw === 'number'
      ? formatNumber(raw, formatCode, date1904, ctx.budget)
      : typeof raw === 'boolean'
        ? raw
          ? 'TRUE'
          : 'FALSE'
        : (raw ?? '');
  const address = `${columnLetters(column, ctx)}${row + 1}`;
  const value: XlsbParsedCell = { row, column, address, text, raw };
  return value;
}

function skipFormula(cursor: XlsbCursor): void {
  cursor.readU16();
  const tokenBytes = cursor.readU32();
  if (tokenBytes > cursor.remaining - 4) throw new CorruptFileError();
  consume(cursor, tokenBytes);
  const extraBytes = cursor.readU32();
  if (extraBytes > cursor.remaining) throw new CorruptFileError();
  consume(cursor, extraBytes);
}

function readU32Payload(record: XlsbRecord, ctx: ReadContext): number {
  const cursor = new XlsbCursor(record.data, ctx.budget);
  const value = cursor.readU32();
  if (cursor.remaining !== 0) throw new CorruptFileError();
  return value;
}

function readRk(value: number): number {
  const isInteger = (value & 2) !== 0;
  const scaled = (value & 1) !== 0;
  let number: number;
  if (isInteger) {
    number = value >> 2;
  } else {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(4, value & 0xffff_fffc, true);
    number = view.getFloat64(0, true);
    if (
      !Number.isFinite(number) ||
      (number !== 0 && Math.abs(number) < MIN_NORMAL_XNUM) ||
      Object.is(number, -0)
    ) {
      throw new CorruptFileError();
    }
  }
  return scaled ? number / 100 : number;
}

function errorValue(code: number): string {
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
    case 0x2b:
      return '#GETTING_DATA';
    default:
      return '#ERROR!';
  }
}

function applyMerges(
  merges: readonly MergeRange[],
  cells: Map<number, Map<number, XlsbParsedCell>>,
  ctx: ReadContext,
): void {
  for (const merge of merges) {
    ctx.budget.tick();
    const anchor = cells.get(merge.firstRow)?.get(merge.firstColumn);
    if (!anchor) continue;
    if (merge.lastRow > merge.firstRow) anchor.rowSpan = merge.lastRow - merge.firstRow + 1;
    if (merge.lastColumn > merge.firstColumn) anchor.colSpan = merge.lastColumn - merge.firstColumn + 1;
  }
}

function compactTables(cells: Map<number, Map<number, XlsbParsedCell>>, ctx: ReadContext): XlsbParsedTable[] {
  const rowIndices = [...cells.keys()];
  rowIndices.sort((left, right) => {
    ctx.budget.tick();
    return left - right;
  });
  const regions: Array<{
    startRow: number;
    endRow: number;
    firstColumn: number;
    lastColumn: number;
    rows: Map<number, Map<number, XlsbParsedCell>>;
  }> = [];
  let previousRow = -2;
  let previous = new Map<string, (typeof regions)[number]>();
  for (const rowIndex of rowIndices) {
    ctx.budget.tick();
    const rowCells = cells.get(rowIndex)!;
    const columns = [...rowCells.keys()];
    columns.sort((left, right) => {
      ctx.budget.tick();
      return left - right;
    });
    const current = new Map<string, (typeof regions)[number]>();
    const extend = rowIndex === previousRow + 1;
    let index = 0;
    while (index < columns.length) {
      ctx.budget.tick();
      const start = index;
      let end = index;
      while (end + 1 < columns.length && columns[end + 1] === columns[end]! + 1) {
        ctx.budget.tick();
        end++;
      }
      const firstColumn = columns[start]!;
      const lastColumn = columns[end]!;
      const key = `${firstColumn}:${lastColumn}`;
      const region = extend ? previous.get(key) : undefined;
      const selected = region ?? {
        startRow: rowIndex,
        endRow: rowIndex,
        firstColumn,
        lastColumn,
        rows: new Map<number, Map<number, XlsbParsedCell>>(),
      };
      if (!region) regions.push(selected);
      selected.endRow = rowIndex;
      selected.rows.set(rowIndex, rowCells);
      current.set(key, selected);
      index = end + 1;
    }
    previous = current;
    previousRow = rowIndex;
  }
  const tables: XlsbParsedTable[] = [];
  for (const region of regions) {
    ctx.budget.tick();
    const rows: Cell[][] = [];
    for (let rowIndex = region.startRow; rowIndex <= region.endRow; rowIndex++) {
      ctx.budget.tick();
      const source = region.rows.get(rowIndex);
      if (!source) continue;
      const row: Cell[] = [];
      for (let column = region.firstColumn; column <= region.lastColumn; column++) {
        ctx.budget.tick();
        const cell = source.get(column);
        if (cell) {
          const { row: sourceRow, column: sourceColumn, ...outputCell } = cell;
          void sourceRow;
          void sourceColumn;
          row.push(outputCell);
        }
      }
      rows.push(row);
    }
    tables.push({
      rows,
      range: formatRange(
        region.startRow + 1,
        region.firstColumn + 1,
        region.endRow + 1,
        region.lastColumn + 1,
        ctx,
      ),
    });
  }
  return tables;
}

function emitWorkbook(workbook: XlsbWorkbook, ctx: ReadContext): void {
  for (const sheet of workbook.sheets) {
    ctx.budget.tick();
    const loc = { sheet: sheet.name, path: partLocation(ctx.path, sheet.part) };
    if (sheet.state !== 'visible') {
      ctx.warnings.add({ code: 'HIDDEN_CONTENT', message: 'The workbook contains a hidden sheet.', loc });
    }
    const opened = ctx.out.openSection('sheet', loc, sheet.name, {
      ...(sheet.state === 'visible' ? {} : { hidden: sheet.state === 'hidden' ? true : 'very' }),
    });
    let stopped = false;
    try {
      if (opened) {
        for (const table of sheet.tables) {
          ctx.budget.tick();
          if (!ctx.out.table(table.rows, 0, { ...loc, range: table.range })) {
            stopped = true;
            break;
          }
        }
      }
    } finally {
      ctx.out.closeSection();
    }
    if (stopped || !opened) break;
  }
}

function firstRelationship(
  relationships: Map<string, OoxmlRelationship>,
  suffix: string,
): OoxmlRelationship | undefined {
  for (const relationship of relationships.values())
    if (relationship.type.endsWith(suffix)) return relationship;
  return undefined;
}

function lastRelationSegment(type: string): string {
  const slash = type.lastIndexOf('/');
  return slash >= 0 ? type.slice(slash) : type;
}

function xmlCtx(ctx: ReadContext): XmlContext {
  return { budget: ctx.budget, warnings: ctx.warnings, ...(ctx.path ? { path: ctx.path } : {}) };
}

function warn(ctx: ReadContext, message: string, path?: string): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message, ...(path ? { loc: { path } } : {}) });
}

function warnOnce(ctx: ReadContext, seen: Set<string>, key: string, message: string, path?: string): void {
  if (seen.has(key)) return;
  seen.add(key);
  warn(ctx, message, path);
}

function isHiddenColumn(column: number, spans: readonly ColumnSpan[], ctx: ReadContext): boolean {
  for (const span of spans) {
    ctx.budget.tick();
    if (column >= span.first && column <= span.last) return true;
  }
  return false;
}

function consume(cursor: XlsbCursor, length: number): void {
  for (let index = 0; index < length; index++) {
    cursor.readU8();
  }
}

function columnLetters(index: number, ctx: ReadContext): string {
  let value = index + 1;
  let output = '';
  while (value > 0) {
    ctx.budget.tick();
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

function formatRange(
  startRow: number,
  startColumn: number,
  endRow: number,
  endColumn: number,
  ctx: ReadContext,
): string {
  const start = `${columnLetters(startColumn - 1, ctx)}${startRow}`;
  const end = `${columnLetters(endColumn - 1, ctx)}${endRow}`;
  return start === end ? start : `${start}:${end}`;
}

function partLocation(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

function asciiFold(value: string, ctx: ReadContext): string {
  let output = '';
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    output += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return output;
}

function corruptWorkbook(): CorruptFileError {
  return new CorruptFileError('The XLSB workbook structure is invalid.');
}

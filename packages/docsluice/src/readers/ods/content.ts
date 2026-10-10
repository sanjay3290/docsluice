import { scanXml } from '../../xml/index.js';
import type { XmlContext } from '../../xml/index.js';
import { formatGeneral } from '../xlsx/numfmt.js';
import type { XlsxCell, XlsxRange, XlsxSheet } from '../xlsx/sheet.js';
import { MAX_COLUMN, MAX_ROW } from '../xlsx/spreadsheetml.js';
import { parseSheetRange } from '../xlsx/workbook.js';

const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const STYLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const DC_NS = 'http://purl.org/dc/elements/1.1/';
/** LibreOffice's unnamed per-sheet database ranges (autofilters): not names a person gave. */
const ANONYMOUS_RANGE = '__Anonymous_Sheet_DB__';
/** `text:s` stands for this many spaces at most; the attribute is a count from the file. */
const MAX_SPACES = 1024;
/**
 * Value cells stored as copies of a repeated row or cell (`number-rows-repeated`,
 * `number-columns-repeated`), per workbook. A few bytes can claim millions of copies; past this
 * many, copies are counted as skipped (a `TRUNCATED` warning) instead of stored.
 */
export const MAX_REPEATED_COPIES = 65_536;
/** Value types whose `office:value` is a number ([ODF 1.3] 19.385). */
const NUMERIC_TYPES: ReadonlySet<string> = new Set(['float', 'percentage', 'currency']);

/** A cell comment (`office:annotation`, XLS-9). */
export interface OdsComment {
  row: number;
  column: number;
  text: string;
  author?: string;
}

/** One `table:table` of the spreadsheet body, in the XLSX sheet model. */
export interface OdsSheet {
  name: string | undefined;
  hidden: boolean;
  sheet: XlsxSheet;
  comments: OdsComment[];
}

/** A named range or database range of one sheet (XLS-9). */
export interface OdsNamedRange {
  name: string;
  sheet: string;
  range: XlsxRange;
  /** Database ranges say whether their first row is a header (`table:contains-header`). */
  headerRows?: number;
}

export interface OdsContent {
  sheets: OdsSheet[];
  named: OdsNamedRange[];
  hasExternalLinks: boolean;
}

export interface OdsContext extends XmlContext {
  /** Keep formula text in `XlsxCell.formula` (the `formulas` option). Formulas are never evaluated. */
  formulas?: boolean;
}

interface OpenCell {
  column: number;
  repeat: number;
  columnSpan: number;
  rowSpan: number;
  covered: boolean;
  valueType: string | undefined;
  attrs: (uri: string, local: string) => string | undefined;
  paragraphs: string[];
  paragraph: string | undefined;
  /** Open elements whose text is not displayed: annotations and nested tables. */
  hiddenDepth: number;
  /** The cell's annotation while it is open, then its finished text. */
  note?: { paragraphs: string[]; paragraph: string | undefined; author?: string; creator?: string };
}

interface RowCell {
  column: number;
  repeat: number;
  value: XlsxCell;
}

/** An `xsd:double` lexical value: digits with an optional sign, point and exponent. */
function isDecimal(value: string, ctx: XmlContext): boolean {
  let digits = 0;
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code >= 48 && code <= 57) digits++;
    else if (code !== 43 && code !== 45 && code !== 46 && code !== 69 && code !== 101) return false;
  }
  return digits > 0;
}

/** A positive decimal count, or `undefined` for anything else. */
function count(value: string | undefined, ctx: XmlContext): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 15) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result > 0 ? result : undefined;
}

/** One part of an OpenFormula reference: `.A1` → `A1`, `$Sheet.A1` → `Sheet!A1`, `'My sheet'.A1` → `'My sheet'!A1`. */
function referencePart(part: string, ctx: XmlContext): string {
  let quote = false;
  for (let index = 0; index < part.length; index++) {
    ctx.budget.tick();
    const char = part[index]!;
    if (char === "'") quote = !quote;
    else if (char === '.' && !quote) {
      if (index === 0) return part.slice(1);
      const sheet = part.startsWith('$') ? part.slice(1, index) : part.slice(0, index);
      return `${sheet}!${part.slice(index + 1)}`;
    }
  }
  return part;
}

/**
 * An OpenFormula expression as an A1 formula: `of:=SUM([.A1:.B2])` → `=SUM(A1:B2)` and
 * `[$Other.A1]` → `Other!A1`. String literals stay as written. Best effort; formulas are never
 * evaluated.
 */
export function odsFormula(formula: string, ctx: XmlContext): string {
  const equals = formula.indexOf('=');
  const colon = formula.indexOf(':');
  let text = colon >= 0 && colon < equals ? formula.slice(colon + 1) : formula;
  if (!text.startsWith('=')) text = `=${text}`;
  let out = '';
  let index = 0;
  while (index < text.length) {
    ctx.budget.tick();
    const char = text[index]!;
    if (char === '"') {
      const end = text.indexOf('"', index + 1);
      const stop = end < 0 ? text.length : end + 1;
      out += text.slice(index, stop);
      index = stop;
      continue;
    }
    if (char !== '[') {
      out += char;
      index++;
      continue;
    }
    // A reference runs to the next `]` outside a quoted sheet name; its parts split on `:`.
    const parts: string[] = [];
    let part = '';
    let quote = false;
    index++;
    while (index < text.length && (quote || text[index] !== ']')) {
      ctx.budget.tick();
      const inner = text[index]!;
      if (inner === "'") quote = !quote;
      if (inner === ':' && !quote) {
        parts.push(part);
        part = '';
      } else part += inner;
      index++;
    }
    parts.push(part);
    index++;
    out += parts.map((value) => referencePart(value, ctx)).join(':');
  }
  return out;
}

/** An ODF range address (`$Sheet1.$A$1:.$B$3`) as one sheet and range, or undefined. */
function rangeAddress(
  address: string | undefined,
  ctx: XmlContext,
): { sheet: string; range: XlsxRange } | undefined {
  if (address === undefined || address.length === 0 || address.length > 512) return undefined;
  // Several areas are separated by spaces; only single-area ranges name a table region.
  if (address.trim().includes(' ')) return undefined;
  const parts: string[] = [];
  let part = '';
  let quote = false;
  for (let index = 0; index < address.length; index++) {
    ctx.budget.tick();
    const char = address[index]!;
    if (char === "'") quote = !quote;
    if (char === ':' && !quote) {
      parts.push(part);
      part = '';
    } else part += char;
  }
  parts.push(part);
  if (parts.length > 2) return undefined;
  const first = referencePart(parts[0]!, ctx);
  let text = first;
  if (parts.length === 2) {
    // The end of a range repeats its sheet (`.$B$3` or `$Sheet1.$B$3`); keep the cell only.
    const end = referencePart(parts[1]!, ctx);
    text += `:${end.slice(end.lastIndexOf('!') + 1)}`;
  }
  return parseSheetRange(text, ctx.budget);
}

/**
 * Parse an ODS `content.xml` with bounded SAX events into sparse sheets. Repeated rows and columns
 * are never expanded when empty; repeated cells with a value are stored one by one against the
 * `cells` budget, and once it is spent the rest are counted arithmetically, never looped over.
 */
export function parseOdsContent(input: Uint8Array, ctx: OdsContext): OdsContent {
  const content: OdsContent = { sheets: [], named: [], hasExternalLinks: false };
  const maxMerges = ctx.budget.limits.cells;
  /** Namespace declarations per open element (`undefined` when it declares none). */
  const scopes: Array<Map<string, string> | undefined> = [];
  /** What each open element is, so close events match their opens. */
  const kinds: string[] = [];
  let spreadsheet = 0;
  /** Table styles with `table:display="false"`: the sheets that use them are hidden. */
  const hiddenStyles = new Set<string>();
  let tableStyle: string | undefined;
  let current: OdsSheet | undefined;
  let nestedTables = 0;
  let full = false;
  let row = 1;
  let rowRepeat = 1;
  let rowCells: RowCell[] = [];
  let rowMerges: XlsxRange[] = [];
  let column = 1;
  let cell: OpenCell | undefined;
  /** Next column number for `table:table-column` declarations of the current sheet. */
  let declaredColumn = 1;
  /** Hidden row ranges of the current sheet (`table:visibility` on rows), in row order. */
  let hiddenRows: Array<{ start: number; end: number }> = [];
  let hiddenColumns: Array<{ start: number; end: number }> = [];

  const resolve = (prefix: string): string | undefined => {
    if (prefix === 'xml') return XML_NS;
    for (let index = scopes.length - 1; index >= 0; index--) {
      ctx.budget.tick();
      const uri = scopes[index]?.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  };

  const attributeReader = (attrs: Map<string, string>) => {
    return (uri: string, local: string): string | undefined => {
      for (const [name, value] of attrs) {
        ctx.budget.tick();
        const colon = name.indexOf(':');
        if (colon < 0 || name.slice(colon + 1) !== local) continue;
        if (resolve(name.slice(0, colon)) === uri) return value;
      }
      return undefined;
    };
  };

  const cellValue = (open: OpenCell): XlsxCell | undefined => {
    if (open.covered) return undefined;
    const attr = open.attrs;
    const formula = attr(TABLE_NS, 'formula');
    const type = open.valueType;
    const shown = open.paragraphs.length > 0 ? open.paragraphs.join('\n') : undefined;
    let value: XlsxCell | undefined;
    if (type !== undefined && NUMERIC_TYPES.has(type)) {
      const raw = attr(OFFICE_NS, 'value');
      const number = raw !== undefined && isDecimal(raw, ctx) ? Number(raw) : Number.NaN;
      if (Number.isFinite(number)) value = { text: shown ?? formatGeneral(number), raw: number };
      else if (shown !== undefined) value = { text: shown };
    } else if (type === 'boolean') {
      const truth = attr(OFFICE_NS, 'boolean-value') === 'true';
      value = { text: shown ?? (truth ? 'TRUE' : 'FALSE'), raw: truth };
    } else if (type === 'date' || type === 'time') {
      const raw = attr(OFFICE_NS, type === 'date' ? 'date-value' : 'time-value');
      const text = shown ?? raw;
      if (text !== undefined) value = raw !== undefined && raw !== text ? { text, raw } : { text };
    } else if (type === 'string') {
      const text = shown ?? attr(OFFICE_NS, 'string-value');
      if (text !== undefined) value = { text };
    } else if (shown !== undefined && shown.length > 0) {
      value = { text: shown };
    }
    if (formula !== undefined) {
      // A formula cell shows its cached value; without one it is empty, as in XLSX (XLS-4).
      if (type === undefined && current) current.sheet.missingCachedValues += open.repeat;
      value ??= { text: '' };
      if (ctx.formulas) value.formula = odsFormula(formula, ctx);
    }
    return value;
  };

  /** Value cells stored as copies of a repeated row or cell, across the workbook. */
  let repeatedCopies = 0;

  const finishRow = (): void => {
    const sheet = current!.sheet;
    const rows = Math.min(rowRepeat, MAX_ROW - row + 1);
    let perRow = 0;
    for (const entry of rowCells) perRow += entry.repeat;
    for (let copy = 0; copy < rows && perRow > 0; copy++) {
      ctx.budget.tick();
      if (copy > 0 && repeatedCopies >= MAX_REPEATED_COPIES) {
        // Later copies of a repeated row are counted, never visited.
        sheet.skippedCells += perRow * (rows - copy);
        sheet.skippedRows += rows - copy;
        break;
      }
      const rowNumber = row + copy;
      let storedInRow = 0;
      for (let entry = 0; entry < rowCells.length; entry++) {
        const { column: start, repeat, value } = rowCells[entry]!;
        for (let offset = 0; offset < repeat; offset++) {
          ctx.budget.tick();
          const isCopy = copy > 0 || offset > 0;
          if (isCopy && repeatedCopies >= MAX_REPEATED_COPIES) {
            sheet.skippedCells += repeat - offset;
            break;
          }
          if (full || ctx.budget.cells >= ctx.budget.limits.cells) {
            full = true;
            // Count the rest of this row, then every later copy, without visiting them.
            let rest = repeat - offset;
            for (let later = entry + 1; later < rowCells.length; later++) rest += rowCells[later]!.repeat;
            sheet.skippedCells += rest + perRow * (rows - copy - 1);
            sheet.skippedRows += (storedInRow === 0 ? 1 : 0) + (rows - copy - 1);
            return;
          }
          let cells = sheet.rows.get(rowNumber);
          if (!cells) {
            cells = new Map();
            sheet.rows.set(rowNumber, cells);
          }
          if (!cells.has(start + offset)) {
            ctx.budget.addCells(1);
            sheet.stored++;
          }
          cells.set(start + offset, isCopy ? { ...value } : value);
          if (isCopy) repeatedCopies++;
          storedInRow++;
        }
      }
      if (storedInRow === 0) sheet.skippedRows++;
    }
    for (const merge of rowMerges) {
      ctx.budget.tick();
      if (sheet.merges.length >= maxMerges) break;
      sheet.merges.push(merge);
    }
  };

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        let declared: Map<string, string> | undefined;
        for (const [name, value] of attrs) {
          ctx.budget.tick();
          if (name.startsWith('xmlns:')) (declared ??= new Map()).set(name.slice(6), value);
        }
        scopes.push(declared);
        const uri = info.namespaceURI;
        const local = info.localName;
        const attr = attributeReader(attrs);
        let kind = '';
        if (uri === XLINK_NS || uri === TEXT_NS || uri === TABLE_NS || uri === OFFICE_NS) {
          const href = attr(XLINK_NS, 'href');
          if (href !== undefined && isExternal(href, ctx)) content.hasExternalLinks = true;
        }
        if (cell) {
          if (uri === TABLE_NS && local === 'table') nestedTables++;
          const note = cell.note;
          if (uri === OFFICE_NS && local === 'annotation' && cell.hiddenDepth === 0 && !note) {
            // The cell's comment: its paragraphs and author are kept apart from the cell text.
            cell.note = { paragraphs: [], paragraph: undefined };
            cell.hiddenDepth++;
            kind = 'annotation';
          } else if (
            (uri === OFFICE_NS && local === 'annotation') ||
            (uri === TABLE_NS && local === 'table')
          ) {
            cell.hiddenDepth++;
            kind = 'hidden';
          } else if (
            note &&
            cell.hiddenDepth === 1 &&
            note.creator === undefined &&
            uri === DC_NS &&
            local === 'creator'
          ) {
            note.creator = '';
            kind = 'creator';
          } else if (note && cell.hiddenDepth === 1 && uri === TEXT_NS) {
            if ((local === 'p' || local === 'h') && note.paragraph === undefined) {
              note.paragraph = '';
              kind = 'note-p';
            } else if (note.paragraph !== undefined && local === 's') {
              note.paragraph += ' '.repeat(Math.min(count(attr(TEXT_NS, 'c'), ctx) ?? 1, MAX_SPACES));
            } else if (note.paragraph !== undefined && local === 'tab') note.paragraph += '\t';
            else if (note.paragraph !== undefined && local === 'line-break') note.paragraph += '\n';
          } else if (cell.hiddenDepth === 0 && uri === TEXT_NS) {
            if ((local === 'p' || local === 'h') && cell.paragraph === undefined) {
              cell.paragraph = '';
              kind = 'p';
            } else if (cell.paragraph !== undefined && local === 's') {
              cell.paragraph += ' '.repeat(Math.min(count(attr(TEXT_NS, 'c'), ctx) ?? 1, MAX_SPACES));
            } else if (cell.paragraph !== undefined && local === 'tab') cell.paragraph += '\t';
            else if (cell.paragraph !== undefined && local === 'line-break') cell.paragraph += '\n';
          }
          kinds.push(kind);
          return;
        }
        if (uri === STYLE_NS && local === 'style' && attr(STYLE_NS, 'family') === 'table') {
          tableStyle = attr(STYLE_NS, 'name');
          kind = 'table-style';
        } else if (uri === STYLE_NS && local === 'table-properties' && tableStyle !== undefined) {
          if (attr(TABLE_NS, 'display') === 'false') hiddenStyles.add(tableStyle);
        } else if (uri === OFFICE_NS && local === 'spreadsheet') {
          spreadsheet++;
          kind = 'spreadsheet';
        } else if (spreadsheet > 0 && uri === TABLE_NS && local === 'table' && !current) {
          current = {
            name: attr(TABLE_NS, 'name'),
            hidden:
              attr(TABLE_NS, 'display') === 'false' || hiddenStyles.has(attr(TABLE_NS, 'style-name') ?? ''),
            sheet: {
              rows: new Map(),
              merges: [],
              stored: 0,
              skippedCells: 0,
              skippedRows: 0,
              missingCachedValues: 0,
            },
            comments: [],
          };
          row = 1;
          declaredColumn = 1;
          hiddenRows = [];
          hiddenColumns = [];
          kind = 'sheet';
        } else if (current && nestedTables === 0 && uri === TABLE_NS && local === 'table-column') {
          const repeat = count(attr(TABLE_NS, 'number-columns-repeated'), ctx) ?? 1;
          const visibility = attr(TABLE_NS, 'visibility');
          if ((visibility === 'collapse' || visibility === 'filter') && declaredColumn <= MAX_COLUMN) {
            hiddenColumns.push({
              start: declaredColumn,
              end: Math.min(MAX_COLUMN, declaredColumn + repeat - 1),
            });
          }
          declaredColumn += repeat;
        } else if (
          spreadsheet > 0 &&
          !current &&
          uri === TABLE_NS &&
          (local === 'named-range' || local === 'database-range')
        ) {
          const name = attr(TABLE_NS, 'name');
          const target = rangeAddress(
            attr(TABLE_NS, local === 'named-range' ? 'cell-range-address' : 'target-range-address'),
            ctx,
          );
          if (name !== undefined && name.length > 0 && !name.startsWith(ANONYMOUS_RANGE) && target) {
            const named: OdsNamedRange = { name, ...target };
            if (local === 'database-range')
              named.headerRows = attr(TABLE_NS, 'contains-header') === 'false' ? 0 : 1;
            content.named.push(named);
          }
        } else if (current && nestedTables === 0 && uri === TABLE_NS && local === 'table-row') {
          rowRepeat = count(attr(TABLE_NS, 'number-rows-repeated'), ctx) ?? 1;
          const visibility = attr(TABLE_NS, 'visibility');
          if ((visibility === 'collapse' || visibility === 'filter') && row <= MAX_ROW) {
            hiddenRows.push({ start: row, end: Math.min(MAX_ROW, row + rowRepeat - 1) });
          }
          rowCells = [];
          rowMerges = [];
          column = 1;
          kind = 'row';
        } else if (
          current &&
          nestedTables === 0 &&
          uri === TABLE_NS &&
          (local === 'table-cell' || local === 'covered-table-cell')
        ) {
          cell = {
            column,
            repeat: count(attr(TABLE_NS, 'number-columns-repeated'), ctx) ?? 1,
            columnSpan: count(attr(TABLE_NS, 'number-columns-spanned'), ctx) ?? 1,
            rowSpan: count(attr(TABLE_NS, 'number-rows-spanned'), ctx) ?? 1,
            covered: local === 'covered-table-cell',
            valueType: attr(OFFICE_NS, 'value-type'),
            attrs: attr,
            paragraphs: [],
            paragraph: undefined,
            hiddenDepth: 0,
          };
          kind = 'cell';
        }
        kinds.push(kind);
      },
      onText(text) {
        if (!cell) return;
        if (cell.hiddenDepth === 0 && cell.paragraph !== undefined) cell.paragraph += text;
        else if (cell.hiddenDepth === 1 && cell.note) {
          if (cell.note.paragraph !== undefined) cell.note.paragraph += text;
          else if (kinds.at(-1) === 'creator') cell.note.creator += text;
        }
      },
      onClose(_name, info) {
        ctx.budget.tick();
        scopes.pop();
        const kind = kinds.pop();
        if (kind === 'annotation') {
          const note = cell!.note!;
          cell!.hiddenDepth--;
          note.author = note.creator?.trim() || undefined;
        } else if (kind === 'note-p') {
          const note = cell!.note!;
          note.paragraphs.push(note.paragraph!);
          note.paragraph = undefined;
        } else if (kind === 'creator') {
          // The creator text is kept as it arrived; nothing to close.
        } else if (kind === 'hidden') {
          cell!.hiddenDepth--;
          if (info.namespaceURI === TABLE_NS && info.localName === 'table') nestedTables--;
        } else if (kind === 'p') {
          cell!.paragraphs.push(cell!.paragraph!);
          cell!.paragraph = undefined;
        } else if (kind === 'cell') {
          const open = cell!;
          cell = undefined;
          const repeat = Math.min(open.repeat, Math.max(0, MAX_COLUMN - open.column + 1));
          column = open.column + open.repeat;
          if (repeat === 0 || row > MAX_ROW) return;
          const text = open.note?.paragraphs.join('\n').trim();
          if (text && !open.covered) {
            const comment: OdsComment = { row, column: open.column, text };
            if (open.note!.author) comment.author = open.note!.author;
            current!.comments.push(comment);
          }
          const value = cellValue({ ...open, repeat });
          if (value) rowCells.push({ column: open.column, repeat, value });
          // A merge is kept for the cell as written; repeated copies of a merged cell are not merged.
          if (!open.covered && (open.columnSpan > 1 || open.rowSpan > 1) && rowMerges.length < maxMerges) {
            rowMerges.push({
              top: row,
              left: open.column,
              bottom: Math.min(MAX_ROW, row + open.rowSpan - 1),
              right: Math.min(MAX_COLUMN, open.column + open.columnSpan - 1),
            });
          }
        } else if (kind === 'row') {
          if (row <= MAX_ROW) finishRow();
          row += rowRepeat;
          rowCells = [];
          rowMerges = [];
        } else if (kind === 'sheet') {
          markHidden(current!.sheet, hiddenRows, hiddenColumns, ctx);
          content.sheets.push(current!);
          current = undefined;
        } else if (kind === 'table-style') {
          tableStyle = undefined;
        } else if (kind === 'spreadsheet') {
          spreadsheet--;
        }
      },
    },
    ctx,
  );
  return content;
}

/**
 * Turn hidden row ranges into the rows that hold values (a range can cover a million repeated rows;
 * only stored rows are looked up) and keep the hidden column ranges (XLS-10).
 */
function markHidden(
  sheet: XlsxSheet,
  rows: ReadonlyArray<{ start: number; end: number }>,
  columns: ReadonlyArray<{ start: number; end: number }>,
  ctx: XmlContext,
): void {
  if (columns.length > 0) sheet.hiddenColumns = columns;
  if (rows.length === 0) return;
  const hidden = new Set<number>();
  const stored = [...sheet.rows.keys()].sort((a, b) => a - b);
  let range = 0;
  for (const row of stored) {
    ctx.budget.tick();
    while (range < rows.length && rows[range]!.end < row) range++;
    if (range === rows.length) break;
    if (rows[range]!.start <= row) hidden.add(row);
  }
  if (hidden.size > 0) sheet.hiddenRows = hidden;
}

/** A link target with a URI scheme or a network path, as opposed to a place in the document. */
function isExternal(target: string, ctx: XmlContext): boolean {
  for (let index = 0; index < target.length; index++) {
    ctx.budget.tick();
    const code = target.charCodeAt(index);
    if (code === 58) return index > 0;
    if (code === 47 || code === 92) return index === 0 && target.charCodeAt(1) === code;
    if (code === 35 || code <= 0x20) return false;
  }
  return false;
}

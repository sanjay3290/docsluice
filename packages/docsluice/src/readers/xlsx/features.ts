import type { Cell } from '../../core/model.js';
import type { Budget } from '../../core/budget.js';
import { LimitExceededError } from '../../core/errors.js';
import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import type { OoxmlParts } from '../../ooxml/parts.js';
import { readRelationships } from '../../ooxml/rels.js';
import type { ParsedCell } from './cells.js';
import { parseCellAddress, formatRange } from './addresses.js';
import { XlsxTextStaging, xlsxStagingXmlContext } from './strings.js';
import type { WorkbookSheet } from './sheets.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const TABLE_REL = `${OFFICE_REL_NS}/table`;
const COMMENTS_REL = `${OFFICE_REL_NS}/comments`;
const THREADED_COMMENTS_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/threadedComment';
const PERSON_REL = 'http://schemas.microsoft.com/office/2017/10/relationships/person';
const THREADED_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments';
const PERSON_NS = 'http://schemas.microsoft.com/office/spreadsheetml/2018/person';
const MAX_FEATURE_OBJECTS = 500_000;
const MAX_FEATURE_TEXT_CHARS = 20_000_000;
const MAX_REFERENCE_CHARS = 1_024;

export interface XlsxRange {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
}

export interface XlsxRangeReference {
  sheetName?: string;
  /** Canonical A1 expression with absolute markers removed. */
  ref: string;
  range: XlsxRange;
}

export interface XlsxDefinedName extends XlsxRangeReference {
  name: string;
  localSheetId?: number;
}

export interface XlsxHiddenColumnRange {
  min: number;
  max: number;
}

export interface XlsxTableFeature {
  id: number;
  name: string;
  displayName: string;
  ref: string;
  range: XlsxRange;
  headerRowCount: number;
  columns: string[];
  path: string;
}

export interface XlsxFeatureNote {
  address: string;
  text: string;
  author?: string;
  path: string;
}

export interface XlsxSheetFeatures {
  sheetName: string;
  sheetPart: string;
  hiddenRows: Set<number>;
  hiddenColumns: XlsxHiddenColumnRange[];
  notes: XlsxFeatureNote[];
  tables: XlsxTableFeature[];
}

export interface XlsxHeaderCell extends Pick<Cell, 'text' | 'raw'> {
  /** Use when available to distinguish typed dates/errors from text payloads. */
  valueType?: 'text' | 'number' | 'boolean' | 'date' | 'error' | 'empty';
}

interface Frame {
  localName: string;
  namespaceURI?: string;
  namespaces: Map<string, string>;
}

interface PendingComment {
  address?: string;
  authorId?: number;
  parts: string[];
  chars: number;
  blocked: boolean;
}

interface WorksheetMarkup {
  hiddenRows: Set<number>;
  hiddenColumns: XlsxHiddenColumnRange[];
  tableRelationshipIds: Set<string>;
}

/** Parse workbook-defined names from the already-read workbook XML. */
export function parseWorkbookDefinedNames(
  bytes: Uint8Array,
  sheets: readonly WorkbookSheet[],
  ctx: XmlContext,
  staging = new XlsxTextStaging(ctx.budget),
): XlsxDefinedName[] {
  const names: XlsxDefinedName[] = [];
  const stack: Frame[] = [];
  let inDefinedNames = false;
  let current:
    | { name?: string; localSheetId?: number; localSheetIdInvalid: boolean; parts: string[]; chars: number }
    | undefined;
  let warned = false;
  let validRoot = false;
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        if (stack.length === 0) validRoot = info.localName === 'workbook' && info.namespaceURI === MAIN;
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'definedNames' &&
          parent?.localName === 'workbook' &&
          parent.namespaceURI === MAIN &&
          stack.length === 1
        )
          inDefinedNames = true;
        if (
          inDefinedNames &&
          info.namespaceURI === MAIN &&
          info.localName === 'definedName' &&
          parent?.localName === 'definedNames' &&
          parent.namespaceURI === MAIN
        ) {
          const rawLocal = attrs.get('localSheetId');
          const localSheetId =
            rawLocal === undefined ? undefined : parseUnsignedDecimal(rawLocal, sheets.length - 1);
          current = {
            name: attrs.get('name'),
            localSheetId,
            localSheetIdInvalid: rawLocal !== undefined && localSheetId === undefined,
            parts: [],
            chars: 0,
          };
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onText(text) {
        ctx.budget.tick();
        if (!current || stack.at(-1)?.localName !== 'definedName' || stack.at(-1)?.namespaceURI !== MAIN)
          return;
        if (current.chars + text.length > MAX_FEATURE_TEXT_CHARS) {
          throw new LimitExceededError('xlsxFeatureTextChars', MAX_FEATURE_TEXT_CHARS);
        }
        staging.reserveObjects();
        current.parts.push(text);
        current.chars += text.length;
      },
      onClose(_name, info) {
        ctx.budget.tick();
        const parent = stack.at(-2);
        if (
          current &&
          info.namespaceURI === MAIN &&
          info.localName === 'definedName' &&
          parent?.localName === 'definedNames' &&
          parent.namespaceURI === MAIN
        ) {
          const name = current.name;
          const rawReference = current.parts.join('').trim();
          const target = parseA1RangeReference(rawReference, ctx.budget);
          let sheetName = target?.sheetName;
          if (sheetName) sheetName = matchSheetName(sheetName, sheets, ctx.budget);
          if (!sheetName && target && target.sheetName) current.localSheetIdInvalid = true;
          if (!sheetName && current.localSheetId !== undefined)
            sheetName = sheets[current.localSheetId]?.name;
          if (
            name &&
            name.length <= MAX_REFERENCE_CHARS &&
            !current.localSheetIdInvalid &&
            target &&
            sheetName
          ) {
            const reference = {
              ...target,
              sheetName,
              ref: formatQualifiedRange(sheetName, target.range, ctx.budget),
            };
            if (staging.reserveOutputChars(name.length)) {
              staging.reserveObjects();
              names.push({
                name,
                ...reference,
                ...(current.localSheetId !== undefined ? { localSheetId: current.localSheetId } : {}),
              });
            }
          } else if (!warned) {
            warnAt(ctx, ctx.path ?? '', 'Unsupported or invalid defined-name references were skipped.');
            warned = true;
          }
          current = undefined;
        }
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'definedNames' &&
          parent?.localName === 'workbook' &&
          parent.namespaceURI === MAIN
        )
          inDefinedNames = false;
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, ctx.path),
  );
  if (!validRoot) warnAt(ctx, ctx.path ?? '', 'Workbook defined names could not be read.');
  return names;
}

/** Read workbook person display names for threaded comments when metadata is enabled. */
export async function readXlsxPeople(
  parts: OoxmlParts,
  workbookPart: string,
  ctx: XmlContext,
  staging = new XlsxTextStaging(ctx.budget),
  includeAuthors = true,
): Promise<Map<string, string>> {
  const people = new Map<string, string>();
  let retainedPersonChars = 0;
  if (!includeAuthors) return people;
  const relationships = await readRelationships(parts, workbookPart, ctx);
  let personPart: string | undefined;
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (!relationship.external && relationship.type === PERSON_REL && relationship.part) {
      personPart = relationship.part;
      break;
    }
  }
  if (!personPart) return people;
  const bytes = await parts.read(personPart);
  if (!bytes) return people;
  const stack: Frame[] = [];
  let validRoot = false;
  let warned = false;
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        if (stack.length === 0)
          validRoot = info.localName === 'personList' && info.namespaceURI === PERSON_NS;
        if (
          info.namespaceURI === PERSON_NS &&
          info.localName === 'person' &&
          parent?.localName === 'personList' &&
          parent.namespaceURI === PERSON_NS &&
          stack.length === 1
        ) {
          const id = attrs.get('id');
          const displayName = attrs.get('displayName');
          if (
            id &&
            id.length <= MAX_REFERENCE_CHARS &&
            displayName !== undefined &&
            displayName.length <= MAX_FEATURE_TEXT_CHARS &&
            people.size < MAX_FEATURE_OBJECTS
          ) {
            if (retainedPersonChars + displayName.length > MAX_FEATURE_TEXT_CHARS)
              throw new LimitExceededError('xlsxFeatureTextChars', MAX_FEATURE_TEXT_CHARS);
            staging.reserveObjects();
            people.set(id, displayName);
            retainedPersonChars += displayName.length;
          } else if (!warned) {
            warnAt(ctx, partLocation(ctx.path, personPart), 'A threaded-comment person record was skipped.');
            warned = true;
          }
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onClose() {
        ctx.budget.tick();
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, partLocation(ctx.path, personPart)),
  );
  if (!validRoot)
    warnAt(ctx, partLocation(ctx.path, personPart), 'Threaded-comment people could not be read.');
  return people;
}

/** Parse one already-read worksheet and its metadata relationship parts. */
export async function parseXlsxSheetFeatureBytes(
  bytes: Uint8Array,
  sheet: WorkbookSheet,
  parts: OoxmlParts,
  people: ReadonlyMap<string, string>,
  ctx: XmlContext,
  staging = new XlsxTextStaging(ctx.budget),
  includeAuthors = true,
): Promise<XlsxSheetFeatures> {
  const markup = parseWorksheetMarkup(bytes, sheet, ctx, staging);
  const output: XlsxSheetFeatures = {
    sheetName: sheet.name,
    sheetPart: sheet.part,
    hiddenRows: markup.hiddenRows,
    hiddenColumns: mergeHiddenColumns(markup.hiddenColumns, ctx.budget, staging),
    notes: [],
    tables: [],
  };
  const relationships = await readRelationships(parts, sheet.part, {
    ...ctx,
    path: partLocation(ctx.path, sheet.part),
  });
  const seenTableParts = new Set<string>();
  for (const id of markup.tableRelationshipIds) {
    ctx.budget.tick();
    const relationship = relationships.get(id);
    if (!relationship || relationship.external || !relationship.part || relationship.type !== TABLE_REL) {
      warnAt(
        ctx,
        partLocation(ctx.path, sheet.part),
        'A worksheet table relationship could not be resolved.',
      );
      continue;
    }
    if (seenTableParts.has(relationship.part)) continue;
    seenTableParts.add(relationship.part);
    const table = await readTablePart(parts, relationship.part, ctx, staging);
    if (table) output.tables.push(table);
  }
  let warnedRelationship = false;
  const seenCommentParts = new Set<string>();
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.external || !relationship.part) continue;
    if (relationship.type === COMMENTS_REL) {
      if (seenCommentParts.has(relationship.part)) continue;
      seenCommentParts.add(relationship.part);
      const notes = await readClassicComments(parts, relationship.part, ctx, staging, includeAuthors);
      for (const note of notes) {
        ctx.budget.tick();
        if (output.notes.length >= MAX_FEATURE_OBJECTS)
          throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
        staging.reserveObjects();
        output.notes.push(note);
      }
    } else if (relationship.type === THREADED_COMMENTS_REL) {
      if (seenCommentParts.has(relationship.part)) continue;
      seenCommentParts.add(relationship.part);
      const notes = await readThreadedComments(
        parts,
        relationship.part,
        people,
        ctx,
        staging,
        includeAuthors,
      );
      for (const note of notes) {
        ctx.budget.tick();
        if (output.notes.length >= MAX_FEATURE_OBJECTS)
          throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
        staging.reserveObjects();
        output.notes.push(note);
      }
    } else if (relationship.type.endsWith('/threadedComment') || relationship.type.endsWith('/comments')) {
      if (!warnedRelationship) {
        warnAt(
          ctx,
          partLocation(ctx.path, sheet.part),
          'An unsupported worksheet comment relationship was skipped.',
        );
        warnedRelationship = true;
      }
    }
  }
  return output;
}

/** Add hidden state to sparse cells without allocating empty row or column slots. */
export function applyHiddenCellFlags(
  cells: Map<number, Map<number, ParsedCell>>,
  features: Pick<XlsxSheetFeatures, 'hiddenRows' | 'hiddenColumns'>,
  budget: Budget,
): void {
  for (const [rowNumber, row] of cells) {
    budget.tick();
    const rowHidden = features.hiddenRows.has(rowNumber);
    for (const [columnNumber, cell] of row) {
      budget.tick();
      if (rowHidden || containsColumn(features.hiddenColumns, columnNumber, budget)) cell.hidden = true;
    }
  }
}

/** Infer leading header rows from a compact table; never expands sparse ranges. */
export function inferHeaderRows(
  rows: readonly (readonly XlsxHeaderCell[])[],
  option: 'auto' | boolean,
  budget: Budget,
): number {
  if (option === true) return 1;
  if (option === false || rows.length < 2) return 0;
  const header = rows[0];
  if (!header?.length) return 0;
  const headerTypes: string[] = [];
  for (const cell of header) {
    budget.tick();
    const type = valueType(cell);
    if (type !== 'text') return 0;
    headerTypes.push(type);
  }
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    budget.tick();
    const row = rows[rowIndex]!;
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      budget.tick();
      const cell = row[columnIndex]!;
      const type = valueType(cell);
      if (type === 'empty') continue;
      if (columnIndex < headerTypes.length && type !== headerTypes[columnIndex]) return 1;
    }
  }
  return 0;
}

/** Parse a single bounded A1 cell/range, optionally qualified by a worksheet name. */
export function parseA1RangeReference(value: string, budget: Budget): XlsxRangeReference | undefined {
  if (value.length === 0 || value.length > MAX_REFERENCE_CHARS) return undefined;
  let cursor = 0;
  let sheetName: string | undefined;
  let sheetWasQuoted = false;
  if (value.charCodeAt(0) === 39) {
    sheetWasQuoted = true;
    cursor = 1;
    let parsed = '';
    let closed = false;
    while (cursor < value.length) {
      budget.tick();
      const code = value.charCodeAt(cursor);
      if (code === 39) {
        if (value.charCodeAt(cursor + 1) === 39) {
          parsed += "'";
          cursor += 2;
          continue;
        }
        cursor += 1;
        closed = true;
        break;
      }
      parsed += value.charAt(cursor);
      cursor += 1;
    }
    if (!closed || value.charCodeAt(cursor) !== 33 || parsed.length === 0) return undefined;
    sheetName = parsed;
    cursor += 1;
  } else {
    let bang = -1;
    for (let index = 0; index < value.length; index += 1) {
      budget.tick();
      if (value.charCodeAt(index) === 33) {
        bang = index;
        break;
      }
    }
    if (bang >= 0) {
      sheetName = value.slice(0, bang);
      if (!validUnquotedSheetName(sheetName, budget)) return undefined;
      cursor = bang + 1;
    }
  }
  let separator = -1;
  for (let index = cursor; index < value.length; index += 1) {
    budget.tick();
    if (value.charCodeAt(index) === 58) {
      if (separator >= 0) return undefined;
      separator = index;
    }
  }
  const leftText = value.slice(cursor, separator < 0 ? value.length : separator);
  const rightText = separator < 0 ? leftText : value.slice(separator + 1);
  const start = parseA1Cell(leftText, budget);
  const end = parseA1Cell(rightText, budget);
  if (!start || !end || end.row < start.row || end.column < start.column) return undefined;
  const ref = formatRange(start.row, start.column, end.row, end.column, budget);
  if (!ref) return undefined;
  if (sheetName !== undefined && !validSheetName(sheetName, budget)) return undefined;
  const prefix =
    sheetName === undefined
      ? ''
      : `${sheetWasQuoted || !validUnquotedSheetName(sheetName, budget) ? quoteSheet(sheetName, budget) : sheetName}!`;
  return {
    ...(sheetName !== undefined ? { sheetName } : {}),
    ref: `${prefix}${ref}`,
    range: {
      startRow: start.row,
      startColumn: start.column,
      endRow: end.row,
      endColumn: end.column,
    },
  };
}

function parseWorksheetMarkup(
  bytes: Uint8Array,
  sheet: WorkbookSheet,
  ctx: XmlContext,
  staging: XlsxTextStaging,
): WorksheetMarkup {
  const hiddenRows = new Set<number>();
  const hiddenColumns: XlsxHiddenColumnRange[] = [];
  const tableRelationshipIds = new Set<string>();
  const stack: Frame[] = [];
  let validRoot = false;
  let warned = false;
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        const grandparent = stack.at(-2);
        if (stack.length === 0) validRoot = info.localName === 'worksheet' && info.namespaceURI === MAIN;
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'row' &&
          parent?.localName === 'sheetData' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'worksheet' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 2 &&
          isOn(attrs.get('hidden'), ctx.budget)
        ) {
          const row = parseUnsignedDecimal(attrs.get('r') ?? '', 1_048_576, ctx.budget);
          if (row === undefined || row < 1) warnOnce();
          else if (!hiddenRows.has(row)) {
            if (hiddenRows.size >= MAX_FEATURE_OBJECTS)
              throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
            staging.reserveObjects();
            hiddenRows.add(row);
          }
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'col' &&
          parent?.localName === 'cols' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'worksheet' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 2 &&
          isOn(attrs.get('hidden'), ctx.budget)
        ) {
          const min = parseUnsignedDecimal(attrs.get('min') ?? '', 16_384, ctx.budget);
          const max = parseUnsignedDecimal(attrs.get('max') ?? '', 16_384, ctx.budget);
          if (min === undefined || max === undefined || min < 1 || max < 1 || min > max) warnOnce();
          else {
            if (hiddenColumns.length >= MAX_FEATURE_OBJECTS)
              throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
            staging.reserveObjects();
            hiddenColumns.push({ min, max });
          }
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'tablePart' &&
          parent?.localName === 'tableParts' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'worksheet' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 2
        ) {
          const relationshipId = relationshipAttribute(attrs, namespaces, ctx.budget);
          if (!relationshipId || relationshipId.length > MAX_REFERENCE_CHARS) warnOnce();
          else {
            if (tableRelationshipIds.size >= MAX_FEATURE_OBJECTS && !tableRelationshipIds.has(relationshipId))
              throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
            if (!tableRelationshipIds.has(relationshipId)) {
              staging.reserveObjects();
              tableRelationshipIds.add(relationshipId);
            }
          }
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onText() {
        ctx.budget.tick();
      },
      onClose() {
        ctx.budget.tick();
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, partLocation(ctx.path, sheet.part)),
  );
  if (!validRoot)
    warnAt(ctx, partLocation(ctx.path, sheet.part), 'Worksheet feature markup could not be read.');
  return { hiddenRows, hiddenColumns, tableRelationshipIds };

  function warnOnce(): void {
    if (warned) return;
    warned = true;
    warnAt(ctx, partLocation(ctx.path, sheet.part), 'Invalid worksheet feature metadata was skipped.');
  }
}

function mergeHiddenColumns(
  ranges: XlsxHiddenColumnRange[],
  budget: Budget,
  staging: XlsxTextStaging,
): XlsxHiddenColumnRange[] {
  ranges.sort((left, right) => {
    budget.tick();
    return left.min - right.min || left.max - right.max;
  });
  const merged: XlsxHiddenColumnRange[] = [];
  for (const range of ranges) {
    budget.tick();
    const previous = merged.at(-1);
    if (previous && range.min <= previous.max + 1) previous.max = Math.max(previous.max, range.max);
    else {
      staging.reserveObjects();
      merged.push({ min: range.min, max: range.max });
    }
  }
  return merged;
}

function containsColumn(ranges: readonly XlsxHiddenColumnRange[], column: number, budget: Budget): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    budget.tick();
    const middle = low + Math.floor((high - low) / 2);
    const range = ranges[middle]!;
    if (column < range.min) high = middle - 1;
    else if (column > range.max) low = middle + 1;
    else return true;
  }
  return false;
}

async function readTablePart(
  parts: OoxmlParts,
  part: string,
  ctx: XmlContext,
  staging: XlsxTextStaging,
): Promise<XlsxTableFeature | undefined> {
  const bytes = await parts.read(part);
  if (!bytes) return undefined;
  const stack: Frame[] = [];
  let validRoot = false;
  let id: number | undefined;
  let name: string | undefined;
  let displayName: string | undefined;
  let reference: string | undefined;
  let range: XlsxRange | undefined;
  let headerRowCount = 1;
  let invalid = false;
  const columns: string[] = [];
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        if (stack.length === 0) {
          validRoot = info.localName === 'table' && info.namespaceURI === MAIN;
          id = parseUnsignedDecimal(attrs.get('id') ?? '', MAX_FEATURE_OBJECTS, ctx.budget);
          if (id === 0) id = undefined;
          name = attrs.get('name');
          displayName = attrs.get('displayName') ?? name;
          reference = attrs.get('ref');
          if (
            (name !== undefined && name.length > 255) ||
            (displayName !== undefined && displayName.length > 255) ||
            (reference !== undefined && reference.length > MAX_REFERENCE_CHARS)
          )
            invalid = true;
          const rawHeaderCount = attrs.get('headerRowCount');
          const parsedHeaderCount =
            rawHeaderCount === undefined ? 1 : parseUnsignedDecimal(rawHeaderCount, 1, ctx.budget);
          if (parsedHeaderCount === undefined) invalid = true;
          else headerRowCount = parsedHeaderCount;
          const parsedRange = reference ? parseA1RangeReference(reference, ctx.budget) : undefined;
          if (!parsedRange || parsedRange.sheetName) invalid = true;
          else range = parsedRange.range;
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'tableColumn' &&
          parent?.localName === 'tableColumns' &&
          parent.namespaceURI === MAIN &&
          stack.length === 2
        ) {
          const columnName = attrs.get('name');
          if (
            columnName === undefined ||
            columnName.length === 0 ||
            columnName.length > 255 ||
            columns.length >= 16_384
          )
            invalid = true;
          else {
            staging.reserveObjects();
            columns.push(columnName);
          }
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onText() {
        ctx.budget.tick();
      },
      onClose() {
        ctx.budget.tick();
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, partLocation(ctx.path, part)),
  );
  if (!validRoot || invalid || id === undefined || !name || !displayName || !reference || !range) {
    warnAt(ctx, partLocation(ctx.path, part), 'A malformed table part was skipped.');
    return undefined;
  }
  const caption = displayName || name;
  if (!staging.reserveOutputChars(caption.length)) return undefined;
  staging.reserveObjects();
  return {
    id,
    name,
    displayName: caption,
    ref: reference,
    range,
    headerRowCount,
    columns,
    path: partLocation(ctx.path, part),
  };
}

async function readClassicComments(
  parts: OoxmlParts,
  part: string,
  ctx: XmlContext,
  staging: XlsxTextStaging,
  includeAuthors: boolean,
): Promise<XlsxFeatureNote[]> {
  const bytes = await parts.read(part);
  if (!bytes) return [];
  const authors: Array<string | undefined> = [];
  const notes: XlsxFeatureNote[] = [];
  const stack: Frame[] = [];
  let validRoot = false;
  let authorParts: string[] | undefined;
  let inAuthor = false;
  let authorChars = 0;
  let retainedAuthorChars = 0;
  let comment: PendingComment | undefined;
  let inCommentText = false;
  let warned = false;
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        if (stack.length === 0) validRoot = info.localName === 'comments' && info.namespaceURI === MAIN;
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'author' &&
          parent?.localName === 'authors' &&
          parent.namespaceURI === MAIN &&
          parentIsDirectMainRoot(stack, 'comments') &&
          stack.length === 2
        ) {
          inAuthor = true;
          authorParts = includeAuthors ? [] : undefined;
          authorChars = 0;
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'comment' &&
          parent?.localName === 'commentList' &&
          parent.namespaceURI === MAIN &&
          parentIsDirectMainRoot(stack, 'comments') &&
          stack.length === 2
        ) {
          const address = parseCellAddress(attrs.get('ref') ?? '', ctx.budget)?.address;
          const rawAuthor = attrs.get('authorId');
          const authorId =
            rawAuthor === undefined ? undefined : parseUnsignedDecimal(rawAuthor, 500_000, ctx.budget);
          comment = {
            address,
            authorId,
            parts: [],
            chars: 0,
            blocked: false,
          };
          if (!address || authorId === undefined) warnOnce();
        } else if (
          comment &&
          info.namespaceURI === MAIN &&
          info.localName === 'text' &&
          parent?.localName === 'comment' &&
          parent.namespaceURI === MAIN
        ) {
          inCommentText = true;
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onText(text) {
        ctx.budget.tick();
        const top = stack.at(-1);
        if (inAuthor && top?.localName === 'author' && top.namespaceURI === MAIN) {
          if (!includeAuthors) return;
          if (retainedAuthorChars + authorChars + text.length > MAX_FEATURE_TEXT_CHARS)
            throw new LimitExceededError('xlsxFeatureTextChars', MAX_FEATURE_TEXT_CHARS);
          staging.reserveObjects();
          authorParts!.push(text);
          authorChars += text.length;
          return;
        }
        if (!comment || !comment.address || !inCommentText || comment.blocked) return;
        if (!(
          (top?.localName === 't' && top.namespaceURI === MAIN) ||
          (top?.localName === 'text' && top.namespaceURI === MAIN)
        ))
          return;
        if (comment.chars + text.length > MAX_FEATURE_TEXT_CHARS)
          throw new LimitExceededError('xlsxFeatureTextChars', MAX_FEATURE_TEXT_CHARS);
        if (!staging.reserveOutputChars(text.length)) {
          comment.blocked = true;
          return;
        }
        staging.reserveObjects();
        comment.parts.push(text);
        comment.chars += text.length;
      },
      onClose(_name, info) {
        ctx.budget.tick();
        const parent = stack.at(-2);
        if (
          inAuthor &&
          info.namespaceURI === MAIN &&
          info.localName === 'author' &&
          parent?.localName === 'authors' &&
          parent.namespaceURI === MAIN
        ) {
          if (authors.length >= MAX_FEATURE_OBJECTS)
            throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
          staging.reserveObjects();
          authors.push(includeAuthors ? authorParts?.join('') : undefined);
          retainedAuthorChars += authorChars;
          authorParts = undefined;
          inAuthor = false;
        } else if (
          comment &&
          info.namespaceURI === MAIN &&
          info.localName === 'text' &&
          parent?.localName === 'comment' &&
          parent.namespaceURI === MAIN
        ) {
          inCommentText = false;
        } else if (
          comment &&
          info.namespaceURI === MAIN &&
          info.localName === 'comment' &&
          parent?.localName === 'commentList' &&
          parent.namespaceURI === MAIN
        ) {
          const text = comment.parts.join('');
          if (comment.address && text.trim()) {
            if (notes.length >= MAX_FEATURE_OBJECTS)
              throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
            const author =
              includeAuthors && comment.authorId !== undefined ? authors[comment.authorId] : undefined;
            staging.reserveObjects();
            notes.push({
              address: comment.address,
              text,
              ...(author !== undefined ? { author } : {}),
              path: partLocation(ctx.path, part),
            });
          }
          comment = undefined;
        }
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, partLocation(ctx.path, part)),
  );
  if (!validRoot) warnAt(ctx, partLocation(ctx.path, part), 'A classic comments part could not be read.');
  return notes;

  function warnOnce(): void {
    if (warned) return;
    warned = true;
    warnAt(ctx, partLocation(ctx.path, part), 'A malformed comment record was skipped.');
  }
}

async function readThreadedComments(
  parts: OoxmlParts,
  part: string,
  people: ReadonlyMap<string, string>,
  ctx: XmlContext,
  staging: XlsxTextStaging,
  includeAuthors: boolean,
): Promise<XlsxFeatureNote[]> {
  const bytes = await parts.read(part);
  if (!bytes) return [];
  const notes: XlsxFeatureNote[] = [];
  const stack: Frame[] = [];
  let validRoot = false;
  let current:
    { address?: string; personId?: string; parts: string[]; chars: number; blocked: boolean } | undefined;
  let inThreadedText = false;
  let warned = false;
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const namespaces = inheritNamespaces(stack.at(-1)?.namespaces, attrs, ctx.budget);
        const parent = stack.at(-1);
        if (stack.length === 0)
          validRoot = info.localName === 'ThreadedComments' && info.namespaceURI === THREADED_NS;
        if (
          info.namespaceURI === THREADED_NS &&
          info.localName === 'threadedComment' &&
          parent?.localName === 'ThreadedComments' &&
          parent.namespaceURI === THREADED_NS &&
          stack.length === 1
        ) {
          const address = parseCellAddress(attrs.get('ref') ?? '', ctx.budget)?.address;
          const rawPersonId = attrs.get('personId');
          const personId = rawPersonId && rawPersonId.length <= MAX_REFERENCE_CHARS ? rawPersonId : undefined;
          current = { address, personId, parts: [], chars: 0, blocked: false };
          if (!address || !personId) warnOnce();
        } else if (
          current &&
          info.namespaceURI === THREADED_NS &&
          info.localName === 'text' &&
          parent?.localName === 'threadedComment' &&
          parent.namespaceURI === THREADED_NS &&
          stack.length === 2
        ) {
          inThreadedText = true;
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI, namespaces });
      },
      onText(text) {
        ctx.budget.tick();
        if (
          !current ||
          !current.address ||
          current.blocked ||
          !inThreadedText ||
          stack.at(-1)?.localName !== 'text' ||
          stack.at(-1)?.namespaceURI !== THREADED_NS
        )
          return;
        if (current.chars + text.length > MAX_FEATURE_TEXT_CHARS)
          throw new LimitExceededError('xlsxFeatureTextChars', MAX_FEATURE_TEXT_CHARS);
        if (!staging.reserveOutputChars(text.length)) {
          current.blocked = true;
          return;
        }
        staging.reserveObjects();
        current.parts.push(text);
        current.chars += text.length;
      },
      onClose(_name, info) {
        ctx.budget.tick();
        const parent = stack.at(-2);
        if (
          current &&
          info.namespaceURI === THREADED_NS &&
          info.localName === 'text' &&
          parent?.localName === 'threadedComment' &&
          parent.namespaceURI === THREADED_NS
        ) {
          inThreadedText = false;
        } else if (
          current &&
          info.namespaceURI === THREADED_NS &&
          info.localName === 'threadedComment' &&
          parent?.localName === 'ThreadedComments' &&
          parent.namespaceURI === THREADED_NS
        ) {
          const text = current.parts.join('');
          const author = includeAuthors && current.personId ? people.get(current.personId) : undefined;
          if (current.address && text.trim()) {
            if (notes.length >= MAX_FEATURE_OBJECTS)
              throw new LimitExceededError('xlsxFeatureObjects', MAX_FEATURE_OBJECTS);
            staging.reserveObjects();
            notes.push({
              address: current.address,
              text,
              ...(author !== undefined ? { author } : {}),
              path: partLocation(ctx.path, part),
            });
          }
          current = undefined;
        }
        stack.pop();
      },
    },
    xlsxStagingXmlContext(ctx.budget, ctx.warnings, partLocation(ctx.path, part)),
  );
  if (!validRoot) warnAt(ctx, partLocation(ctx.path, part), 'A threaded comments part could not be read.');
  return notes;

  function warnOnce(): void {
    if (warned) return;
    warned = true;
    warnAt(ctx, partLocation(ctx.path, part), 'A malformed threaded comment was skipped.');
  }
}

function parseA1Cell(value: string, budget: Budget): { row: number; column: number } | undefined {
  let cursor = 0;
  if (value.charCodeAt(cursor) === 36) cursor += 1;
  const columnStart = cursor;
  let column = 0;
  while (cursor < value.length) {
    budget.tick();
    const code = foldAsciiCode(value.charCodeAt(cursor));
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
    if (column > 16_384) return undefined;
    cursor += 1;
  }
  if (cursor === columnStart) return undefined;
  if (value.charCodeAt(cursor) === 36) cursor += 1;
  const rowStart = cursor;
  let row = 0;
  while (cursor < value.length) {
    budget.tick();
    const code = value.charCodeAt(cursor);
    if (code < 48 || code > 57) return undefined;
    row = row * 10 + code - 48;
    if (row > 1_048_576) return undefined;
    cursor += 1;
  }
  if (rowStart === cursor || row < 1) return undefined;
  return { row, column };
}

function parseUnsignedDecimal(value: string, maximum: number, budget?: Budget): number | undefined {
  if (value.length === 0 || value.length > 10) return undefined;
  let number = 0;
  for (let index = 0; index < value.length; index += 1) {
    budget?.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    number = number * 10 + code - 48;
    if (number > maximum) return undefined;
  }
  return number;
}

function valueType(cell: XlsxHeaderCell): string {
  if (cell.valueType) return cell.valueType;
  if (cell.raw === null || cell.raw === undefined || cell.raw === '') return 'empty';
  if (typeof cell.raw === 'number') return 'number';
  if (typeof cell.raw === 'boolean') return 'boolean';
  return 'text';
}

function inheritNamespaces(
  parent: Map<string, string> | undefined,
  attrs: Map<string, string>,
  budget: Budget,
): Map<string, string> {
  let namespaces = parent ?? new Map<string, string>();
  let copied = false;
  for (const [name, value] of attrs) {
    budget.tick();
    if (name !== 'xmlns' && !name.startsWith('xmlns:')) continue;
    if (!copied) {
      namespaces = new Map(namespaces);
      copied = true;
    }
    if (name === 'xmlns') namespaces.set('', value);
    else namespaces.set(name.slice(6), value);
  }
  return namespaces;
}

function relationshipAttribute(
  attrs: Map<string, string>,
  namespaces: Map<string, string>,
  budget: Budget,
): string | undefined {
  for (const [name, value] of attrs) {
    budget.tick();
    const colon = name.indexOf(':');
    if (colon <= 0 || name.slice(colon + 1) !== 'id') continue;
    if (namespaces.get(name.slice(0, colon)) === OFFICE_REL_NS) return value;
  }
  return undefined;
}

function parentIsDirectMainRoot(stack: readonly Frame[], rootName: string): boolean {
  const root = stack[0];
  return root?.localName === rootName && root.namespaceURI === MAIN;
}

function matchSheetName(name: string, sheets: readonly WorkbookSheet[], budget: Budget): string | undefined {
  const folded = foldAscii(name, budget);
  for (const sheet of sheets) {
    budget.tick();
    if (foldAscii(sheet.name, budget) === folded) return sheet.name;
  }
  return undefined;
}

function foldAscii(value: string, budget: Budget): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    budget.tick();
    output += String.fromCharCode(foldAsciiCode(value.charCodeAt(index)));
  }
  return output;
}

function foldAsciiCode(code: number): number {
  return code >= 97 && code <= 122 ? code - 32 : code;
}

function validSheetName(value: string, budget: Budget): boolean {
  if (!value || value.length > 31) return false;
  for (let index = 0; index < value.length; index += 1) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (
      code === 39 ||
      code === 91 ||
      code === 93 ||
      code === 58 ||
      code === 42 ||
      code === 63 ||
      code === 47 ||
      code === 92 ||
      code < 32
    )
      return false;
  }
  return true;
}

function validUnquotedSheetName(value: string, budget: Budget): boolean {
  if (!validSheetName(value, budget)) return false;
  for (let index = 0; index < value.length; index += 1) {
    budget.tick();
    if (value.charCodeAt(index) <= 32) return false;
  }
  return true;
}

function quoteSheet(name: string, budget: Budget): string {
  let escaped = "'";
  for (let index = 0; index < name.length; index += 1) {
    budget.tick();
    const char = name.charAt(index);
    escaped += char === "'" ? "''" : char;
  }
  return `${escaped}'`;
}

function formatQualifiedRange(sheetName: string, range: XlsxRange, budget: Budget): string {
  const sheet = validUnquotedSheetName(sheetName, budget) ? sheetName : quoteSheet(sheetName, budget);
  return `${sheet}!${formatRange(range.startRow, range.startColumn, range.endRow, range.endColumn, budget)}`;
}

function isOn(value: string | undefined, budget: Budget): boolean {
  if (value === undefined) return false;
  const folded = foldAscii(value, budget);
  return folded === '1' || folded === 'TRUE' || folded === 'ON';
}

function partLocation(prefix: string | undefined, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

function warnAt(ctx: XmlContext, path: string, message: string): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message, ...(path ? { loc: { path } } : {}) });
}

import type { Cell } from '../../core/model.js';
import type { Budget } from '../../core/budget.js';
import type { WarningSink } from '../../core/warnings.js';
import { scanXml } from '../../xml/index.js';
import { formatRange, parseCellAddress } from './addresses.js';
import { XlsxTextStaging, xlsxStagingXmlContext } from './strings.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const MAX_MERGES = 500_000;

export interface ParsedCell extends Cell {
  row: number;
  column: number;
}

export interface ParsedTable {
  rows: Cell[][];
  range: string;
  keptCells: number;
}

export interface ParsedSheetCells {
  cells: Map<number, Map<number, ParsedCell>>;
  tables: ParsedTable[];
  range?: string;
  seenCells: number;
  keptCells: number;
  skippedCells: number;
  keptRows: number;
  skippedRows: number;
}

interface PendingCell {
  row: number;
  column: number;
  address: string;
  type: string;
  value: string;
  valueParts: string[];
  valueChars: number;
  inlineParts: string[];
  inlineChars: number;
  inInlineString: boolean;
  inValue: boolean;
  inInlineText: boolean;
  inPhonetic: boolean;
  textExceeded: boolean;
  valueExceeded: boolean;
}

/** Parse worksheet cell records into sparse row/column maps and compact table regions. */
export function parseWorksheetCells(
  bytes: Uint8Array,
  sharedStrings: readonly string[],
  budget: Budget,
  warnings: WarningSink,
  path?: string,
  staging = new XlsxTextStaging(budget),
): ParsedSheetCells {
  const cells = new Map<number, Map<number, ParsedCell>>();
  const merges: Array<{ row: number; column: number; rowSpan: number; colSpan: number; address: string }> =
    [];
  let cell: PendingCell | undefined;
  let row = 0;
  let rowHadCell = false;
  let rowKeptCell = false;
  let seenCells = 0;
  let keptCells = 0;
  let skippedCells = 0;
  let keptRows = 0;
  let skippedRows = 0;
  let validRoot = false;
  let inSheetData = false;
  let inRow = false;
  let warnedBadAddress = false;
  let warnedDuplicateAddress = false;
  let warnedMergeLimit = false;
  let warnedBadString = false;
  let warnedStringIndex = false;
  let malformed = false;
  const stack: Array<{ localName: string; namespaceURI?: string }> = [];
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        budget.tick();
        if (!validRoot) {
          if (stack.length === 0 && info.localName === 'worksheet' && info.namespaceURI === MAIN)
            validRoot = true;
          else malformed = true;
        }
        const parent = stack.at(-1);
        const grandparent = stack.at(-2);
        if (
          info.namespaceURI === MAIN &&
          info.localName === 'sheetData' &&
          parent?.localName === 'worksheet' &&
          parent.namespaceURI === MAIN &&
          stack.length === 1
        )
          inSheetData = true;
        else if (
          info.namespaceURI === MAIN &&
          info.localName === 'row' &&
          inSheetData &&
          parent?.localName === 'sheetData' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'worksheet' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 2
        ) {
          inRow = true;
          const value = Number(attrs.get('r'));
          row = Number.isSafeInteger(value) && value > 0 && value <= 1_048_576 ? value : row + 1;
          rowHadCell = false;
          rowKeptCell = false;
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'c' &&
          inRow &&
          parent?.localName === 'row' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'sheetData' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 3
        ) {
          const address = attrs.get('r') ?? '';
          const parsed = parseCellAddress(address, budget);
          const explicitRow = parsed?.row ?? row;
          if (!parsed) warnedBadAddress = true;
          staging.reserveObjects();
          cell = {
            row: explicitRow,
            column: parsed?.column ?? 0,
            address,
            type: attrs.get('t') ?? 'n',
            value: '',
            valueParts: [],
            valueChars: 0,
            inlineParts: [],
            inlineChars: 0,
            inInlineString: false,
            inValue: false,
            inInlineText: false,
            inPhonetic: false,
            textExceeded: false,
            valueExceeded: false,
          };
          rowHadCell = true;
          seenCells += 1;
        } else if (
          cell &&
          info.namespaceURI === MAIN &&
          info.localName === 'v' &&
          parent?.localName === 'c' &&
          parent.namespaceURI === MAIN &&
          stack.length === 4
        )
          cell.inValue = true;
        else if (
          cell &&
          info.namespaceURI === MAIN &&
          info.localName === 'is' &&
          parent?.localName === 'c' &&
          parent.namespaceURI === MAIN &&
          cell.type === 'inlineStr'
        )
          cell.inInlineString = true;
        else if (
          cell &&
          info.namespaceURI === MAIN &&
          info.localName === 'rPh' &&
          parent?.localName === 'is' &&
          parent.namespaceURI === MAIN
        )
          cell.inPhonetic = true;
        else if (
          cell &&
          info.namespaceURI === MAIN &&
          info.localName === 't' &&
          cell.type === 'inlineStr' &&
          cell.inInlineString &&
          !cell.inPhonetic &&
          ((parent?.localName === 'is' && parent.namespaceURI === MAIN && stack.length === 5) ||
            (parent?.localName === 'r' &&
              parent.namespaceURI === MAIN &&
              grandparent?.localName === 'is' &&
              grandparent.namespaceURI === MAIN &&
              stack.length === 6))
        )
          cell.inInlineText = !cell.inPhonetic;
        else if (
          info.namespaceURI === MAIN &&
          info.localName === 'mergeCell' &&
          parent?.localName === 'mergeCells' &&
          parent.namespaceURI === MAIN &&
          grandparent?.localName === 'worksheet' &&
          grandparent.namespaceURI === MAIN &&
          stack.length === 2
        ) {
          const reference = attrs.get('ref') ?? '';
          const colon = reference.indexOf(':');
          const start = parseCellAddress(colon < 0 ? reference : reference.slice(0, colon), budget);
          const end = parseCellAddress(colon < 0 ? reference : reference.slice(colon + 1), budget);
          if (start && end && end.row >= start.row && end.column >= start.column) {
            if (merges.length < MAX_MERGES) {
              staging.reserveObjects();
              merges.push({
                row: start.row,
                column: start.column,
                rowSpan: end.row - start.row + 1,
                colSpan: end.column - start.column + 1,
                address: start.address,
              });
            } else if (!warnedMergeLimit) {
              warnings.add({
                code: 'UNREADABLE_PART',
                message: 'A worksheet merge range count exceeded the bounded reader capacity.',
                ...(path ? { loc: { path } } : {}),
              });
              warnedMergeLimit = true;
            }
          }
        }
        stack.push({ localName: info.localName, namespaceURI: info.namespaceURI });
      },
      onText(text) {
        budget.tick();
        if (!cell) return;
        if (cell.inValue && stack.at(-1)?.localName === 'v' && stack.at(-1)?.namespaceURI === MAIN) {
          if (cell.type === 's') {
            if (cell.value.length + text.length > 16) cell.valueExceeded = true;
            else if (!cell.valueExceeded) {
              staging.reserveObjects();
              cell.value += text;
            }
          } else if (
            staging.canReserveOutputChars(cell.valueChars + text.length) &&
            cell.valueParts.length < 100_000
          ) {
            staging.reserveObjects();
            cell.valueParts.push(text);
            cell.valueChars += text.length;
          } else cell.textExceeded = true;
        }
        if (cell.inInlineText && stack.at(-1)?.localName === 't' && stack.at(-1)?.namespaceURI === MAIN) {
          if (
            staging.canReserveOutputChars(cell.inlineChars + text.length) &&
            cell.inlineParts.length < 100_000
          ) {
            staging.reserveObjects();
            cell.inlineParts.push(text);
            cell.inlineChars += text.length;
          } else cell.textExceeded = true;
        }
      },
      onClose(_name, info) {
        budget.tick();
        const parent = stack.at(-2);
        if (
          info.namespaceURI === MAIN &&
          cell &&
          info.localName === 'v' &&
          parent?.localName === 'c' &&
          parent.namespaceURI === MAIN &&
          stack.length === 5
        )
          cell.inValue = false;
        if (
          info.namespaceURI === MAIN &&
          cell &&
          info.localName === 't' &&
          cell.type === 'inlineStr' &&
          stack.at(-1)?.localName === 't' &&
          stack.at(-1)?.namespaceURI === MAIN &&
          ((parent?.localName === 'is' && parent.namespaceURI === MAIN && stack.length === 6) ||
            (parent?.localName === 'r' &&
              parent.namespaceURI === MAIN &&
              stack.at(-3)?.localName === 'is' &&
              stack.at(-3)?.namespaceURI === MAIN &&
              stack.length === 7))
        )
          cell.inInlineText = false;
        if (
          info.namespaceURI === MAIN &&
          cell &&
          info.localName === 'rPh' &&
          parent?.localName === 'is' &&
          parent.namespaceURI === MAIN &&
          stack.length === 6
        )
          cell.inPhonetic = false;
        if (
          info.namespaceURI === MAIN &&
          cell &&
          info.localName === 'is' &&
          parent?.localName === 'c' &&
          parent.namespaceURI === MAIN &&
          stack.length === 5
        )
          cell.inInlineString = false;
        if (
          info.namespaceURI === MAIN &&
          cell &&
          info.localName === 'c' &&
          parent?.localName === 'row' &&
          parent.namespaceURI === MAIN &&
          stack.at(-3)?.localName === 'sheetData' &&
          stack.at(-3)?.namespaceURI === MAIN &&
          stack.length === 4 &&
          inSheetData
        ) {
          const parsedCell = makeCell(cell, sharedStrings, () => {
            if (warnedStringIndex) return;
            warnedStringIndex = true;
            warnings.add({
              code: 'UNREADABLE_PART',
              message: 'A shared string index could not be resolved.',
              ...(path ? { loc: { path } } : {}),
            });
          });
          if (!parsedCell) {
            warnedBadString = true;
            skippedCells += 1;
          } else {
            const rowCells = cells.get(parsedCell.row);
            if (rowCells?.has(parsedCell.column)) {
              if (!warnedDuplicateAddress) {
                warnings.add({
                  code: 'UNREADABLE_PART',
                  message: 'A worksheet contained duplicate cell addresses.',
                  ...(path ? { loc: { path } } : {}),
                });
                warnedDuplicateAddress = true;
              }
              skippedCells += 1;
            } else if (
              staging.canReserveOutputChars(parsedCell.text.length) &&
              budget.addCells(1) &&
              staging.reserveOutputChars(parsedCell.text.length)
            ) {
              const destination = rowCells ?? new Map<number, ParsedCell>();
              if (!rowCells) staging.reserveObjects();
              staging.reserveObjects();
              destination.set(parsedCell.column, parsedCell);
              cells.set(parsedCell.row, destination);
              keptCells += 1;
              rowKeptCell = true;
            } else {
              skippedCells += 1;
            }
          }
          cell = undefined;
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'row' &&
          parent?.localName === 'sheetData' &&
          parent.namespaceURI === MAIN &&
          inSheetData &&
          stack.length === 3
        ) {
          if (rowKeptCell) keptRows += 1;
          else if (rowHadCell) skippedRows += 1;
          inRow = false;
        } else if (
          info.namespaceURI === MAIN &&
          info.localName === 'sheetData' &&
          parent?.localName === 'worksheet' &&
          parent.namespaceURI === MAIN &&
          stack.length === 2
        )
          inSheetData = false;
        stack.pop();
      },
    },
    xlsxStagingXmlContext(budget, warnings, path),
  );
  if (!validRoot || malformed || warnedBadAddress || warnedBadString) {
    warnings.add({
      code: 'UNREADABLE_PART',
      message: 'A worksheet part contained unreadable cell data.',
      ...(path ? { loc: { path } } : {}),
    });
  }
  for (const merge of merges) {
    budget.tick();
    const anchor = cells.get(merge.row)?.get(merge.column);
    if (anchor && anchor.address === merge.address) {
      if (merge.rowSpan > 1) anchor.rowSpan = merge.rowSpan;
      if (merge.colSpan > 1) anchor.colSpan = merge.colSpan;
    }
  }
  const tables = compactTables(cells, budget, staging);
  const first = tables[0];
  return {
    cells,
    tables,
    ...(tables.length === 1 ? { range: first?.range } : {}),
    seenCells,
    keptCells,
    skippedCells,
    keptRows,
    skippedRows,
  };
}

function makeCell(
  pending: PendingCell,
  sharedStrings: readonly string[],
  warnSharedString: () => void,
): ParsedCell | undefined {
  if (pending.textExceeded || pending.valueExceeded) return undefined;
  const value = pending.type === 's' ? pending.value : pending.valueParts.join('');
  let text: string;
  let raw: string | number | boolean | null;
  switch (pending.type) {
    case 's': {
      const indexText = value.trim();
      const index = /^\d{1,16}$/u.test(indexText) ? Number(indexText) : Number.NaN;
      const shared = Number.isSafeInteger(index) ? sharedStrings[index] : undefined;
      if (shared === undefined) {
        warnSharedString();
        text = '';
        raw = '';
      } else {
        text = shared;
        raw = shared;
      }
      break;
    }
    case 'inlineStr':
      text = pending.inlineParts.join('');
      raw = text;
      break;
    case 'b': {
      const boolValue = value === '1' || value === 'true';
      text = boolValue ? 'TRUE' : 'FALSE';
      raw = boolValue;
      break;
    }
    case 'n':
      text = value;
      raw = value.length > 0 && Number.isFinite(Number(value)) ? Number(value) : value;
      break;
    case 'e':
    case 'str':
    case 'd':
      text = value;
      raw = value;
      break;
    default:
      text = value;
      raw = value;
      break;
  }
  if (!pending.address || pending.column === 0) return undefined;
  return { row: pending.row, column: pending.column, text, raw, address: pending.address };
}

function compactTables(
  cells: Map<number, Map<number, ParsedCell>>,
  budget: Budget,
  staging: XlsxTextStaging,
): ParsedTable[] {
  const rowIndexes: number[] = [];
  for (const rowIndex of cells.keys()) {
    budget.tick();
    staging.reserveObjects();
    rowIndexes.push(rowIndex);
  }
  rowIndexes.sort((left, right) => {
    budget.tick();
    return left - right;
  });
  const regions: Array<{
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
    rows: Map<number, Map<number, ParsedCell>>;
  }> = [];
  let previousRow = 0;
  let previousRegions = new Map<string, (typeof regions)[number]>();
  for (const rowIndex of rowIndexes) {
    budget.tick();
    const rowCells = cells.get(rowIndex)!;
    const columns: number[] = [];
    for (const column of rowCells.keys()) {
      budget.tick();
      staging.reserveObjects();
      columns.push(column);
    }
    columns.sort((left, right) => {
      budget.tick();
      return left - right;
    });
    const currentRegions = new Map<string, (typeof regions)[number]>();
    const canExtendPrevious = previousRow + 1 === rowIndex;
    let start = 0;
    while (start < columns.length) {
      budget.tick();
      let end = start;
      while (end + 1 < columns.length && columns[end + 1] === columns[end]! + 1) {
        budget.tick();
        end += 1;
      }
      const firstColumn = columns[start]!;
      const lastColumn = columns[end]!;
      const spanKey = `${firstColumn}:${lastColumn}`;
      let region = canExtendPrevious ? previousRegions.get(spanKey) : undefined;
      if (!region) {
        staging.reserveObjects(2);
        region = {
          startRow: rowIndex,
          endRow: rowIndex,
          startColumn: firstColumn,
          endColumn: lastColumn,
          rows: new Map(),
        };
        regions.push(region);
      } else region.endRow = rowIndex;
      staging.reserveObjects();
      region.rows.set(rowIndex, rowCells);
      currentRegions.set(spanKey, region);
      start = end + 1;
    }
    previousRow = rowIndex;
    previousRegions = currentRegions;
  }
  regions.sort((left, right) => {
    budget.tick();
    return left.startRow - right.startRow || left.startColumn - right.startColumn;
  });
  const tables: ParsedTable[] = [];
  for (const region of regions) {
    budget.tick();
    staging.reserveObjects();
    const dense: Cell[][] = [];
    let keptCells = 0;
    for (let rowIndex = region.startRow; rowIndex <= region.endRow; rowIndex += 1) {
      budget.tick();
      staging.reserveObjects();
      const row: Cell[] = [];
      for (let column = region.startColumn; column <= region.endColumn; column += 1) {
        budget.tick();
        const cell = region.rows.get(rowIndex)?.get(column);
        if (cell) {
          staging.reserveObjects();
          row.push({
            text: cell.text,
            raw: cell.raw,
            address: cell.address,
            ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
            ...(cell.colSpan ? { colSpan: cell.colSpan } : {}),
          });
          keptCells += 1;
        } else {
          staging.reserveObjects();
          row.push({ text: '', address: `${columnName(column, budget)}${rowIndex}` });
        }
      }
      dense.push(row);
    }
    tables.push({
      rows: dense,
      range: formatRange(region.startRow, region.startColumn, region.endRow, region.endColumn, budget),
      keptCells,
    });
  }
  return tables;
}

function columnName(column: number, budget: Budget): string {
  let value = column;
  let output = '';
  while (value > 0) {
    budget.tick();
    const remainder = (value - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    value = Math.floor((value - 1) / 26);
  }
  return output;
}

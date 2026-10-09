import type { Budget } from '../../core/budget.js';
import type { Location, Cell } from '../../core/model.js';
import { LimitExceededError } from '../../core/errors.js';
import { parseA1RangeReference } from './features.js';
import type { XlsxDefinedName, XlsxRange, XlsxSheetFeatures, XlsxTableFeature } from './features.js';
import { applyHiddenCellFlags, inferHeaderRows } from './features.js';
import { parseCellAddress, formatRange } from './addresses.js';
import type { ParsedCell, ParsedSheetCells, ParsedTable } from './cells.js';
import type { XlsxTextStaging } from './strings.js';
import type { WorkbookSheet } from './sheets.js';

const MAX_INTEGRATION_OBJECTS = 500_000;

export interface PreparedXlsxNote {
  text: string;
  author?: string;
  loc: Location;
}

export type PreparedXlsxTable = ParsedTable & {
  caption?: string;
  headerRows: number;
};

export interface XlsxFeatureIntegrationResult {
  notes: PreparedXlsxNote[];
  tables: PreparedXlsxTable[];
}

/** Apply parsed worksheet metadata to sparse cells and compact table blocks in place. */
export function integrateXlsxSheetFeatures(
  parsed: ParsedSheetCells,
  sheet: WorkbookSheet,
  features: XlsxSheetFeatures,
  definedNames: readonly XlsxDefinedName[],
  budget: Budget,
  staging: XlsxTextStaging,
  headerRowOption: 'auto' | boolean,
  includeAuthors = true,
): XlsxFeatureIntegrationResult {
  applyHiddenCellFlags(parsed.cells, features, budget);

  const tableParts = new Map<string, XlsxTableFeature>();
  let appendLimitReached = false;
  for (const tablePart of features.tables) {
    budget.tick();
    const key = rangeKey(tablePart.range);
    if (!tableParts.has(key)) {
      staging.reserveObjects();
      tableParts.set(key, tablePart);
    }
  }

  const existingTables = new Map<string, PreparedXlsxTable>();
  for (const table of parsed.tables) {
    budget.tick();
    const reference = parseA1RangeReference(table.range, budget);
    const range = reference?.range;
    const match = range ? tableParts.get(rangeKey(range)) : undefined;
    const prepared = table as PreparedXlsxTable;
    if (match) {
      prepared.caption = match.displayName;
      prepared.headerRows = match.headerRowCount;
    } else {
      prepared.headerRows = inferHeaderRows(table.rows, headerRowOption, budget);
    }
    applyHiddenTableFlags(prepared, features, budget);
    if (range) {
      staging.reserveObjects();
      existingTables.set(rangeKey(range), prepared);
    }
  }

  const represented = new Set<string>();
  for (const table of parsed.tables) {
    budget.tick();
    const range = parseA1RangeReference(table.range, budget)?.range;
    if (range && tableParts.has(rangeKey(range))) {
      staging.reserveObjects();
      represented.add(rangeKey(range));
    }
  }

  for (const tablePart of features.tables) {
    budget.tick();
    if (appendLimitReached) break;
    const key = rangeKey(tablePart.range);
    if (represented.has(key)) continue;
    const blocks = compactRange(parsed.cells, tablePart.range, budget, staging);
    for (const block of blocks) {
      budget.tick();
      const blockRange = parseA1RangeReference(block.range, budget)?.range;
      if (!blockRange) continue;
      const blockKey = rangeKey(blockRange);
      const existing = existingTables.get(rangeKey(blockRange));
      if (existing) {
        existing.caption = tablePart.displayName;
        existing.headerRows = tablePart.headerRowCount;
        staging.reserveObjects();
        represented.add(key);
        continue;
      }
      if (
        !appendPreparedTable(parsed, block, tablePart.displayName, tablePart.headerRowCount, budget, staging)
      ) {
        appendLimitReached = true;
        break;
      }
      applyHiddenTableFlags(block, features, budget);
      staging.reserveObjects();
      existingTables.set(blockKey, block as PreparedXlsxTable);
    }
    staging.reserveObjects();
    represented.add(key);
  }

  const seenNamedRanges = new Set<string>();
  for (const definedName of definedNames) {
    budget.tick();
    if (appendLimitReached) break;
    if (definedName.sheetName !== sheet.name) continue;
    const key = rangeKey(definedName.range);
    if (seenNamedRanges.has(key) || represented.has(key)) continue;
    staging.reserveObjects();
    seenNamedRanges.add(key);
    const blocks = compactRange(parsed.cells, definedName.range, budget, staging);
    for (const block of blocks) {
      budget.tick();
      const blockRange = parseA1RangeReference(block.range, budget)?.range;
      if (!blockRange) continue;
      const blockKey = rangeKey(blockRange);
      const existing = existingTables.get(blockKey);
      if (existing) {
        if (existing.caption === undefined) existing.caption = definedName.name;
        continue;
      }
      const headerRows = inferHeaderRows(block.rows, headerRowOption, budget);
      if (!appendPreparedTable(parsed, block, definedName.name, headerRows, budget, staging)) {
        appendLimitReached = true;
        break;
      }
      applyHiddenTableFlags(block, features, budget);
      staging.reserveObjects();
      existingTables.set(blockKey, block as PreparedXlsxTable);
    }
    staging.reserveObjects();
    represented.add(key);
  }

  const notes: Array<{ note: PreparedXlsxNote; row: number; column: number; sourceOrder: number }> = [];
  for (let sourceOrder = 0; sourceOrder < features.notes.length; sourceOrder += 1) {
    budget.tick();
    const note = features.notes[sourceOrder]!;
    const address = parseCellAddress(note.address, budget);
    if (!address) continue;
    staging.reserveObjects(3);
    notes.push({
      note: {
        text: note.text,
        ...(includeAuthors && note.author !== undefined ? { author: note.author } : {}),
        loc: { sheet: sheet.name, path: note.path, range: address.address },
      },
      row: address.row,
      column: address.column,
      sourceOrder,
    });
  }
  notes.sort((left, right) => {
    budget.tick();
    return left.row - right.row || left.column - right.column || left.sourceOrder - right.sourceOrder;
  });
  const orderedNotes: PreparedXlsxNote[] = [];
  for (const entry of notes) {
    budget.tick();
    staging.reserveObjects();
    orderedNotes.push(entry.note);
  }
  return { notes: orderedNotes, tables: parsed.tables as PreparedXlsxTable[] };
}

function appendPreparedTable(
  parsed: ParsedSheetCells,
  table: ParsedTable,
  caption: string,
  headerRows: number,
  budget: Budget,
  staging: XlsxTextStaging,
): boolean {
  if (parsed.tables.length >= MAX_INTEGRATION_OBJECTS)
    throw new LimitExceededError('xlsxFeatureObjects', MAX_INTEGRATION_OBJECTS);
  budget.tick();
  let outputChars = caption.length;
  let formulaChars = 0;
  for (const row of table.rows) {
    budget.tick();
    for (const cell of row) {
      budget.tick();
      outputChars += cell.text.length;
      if (cell.formula !== undefined) formulaChars += cell.formula.length;
      if (!Number.isSafeInteger(outputChars) || !Number.isSafeInteger(formulaChars))
        throw new LimitExceededError('xlsxFeatureOutputChars', Number.MAX_SAFE_INTEGER);
    }
  }
  const stagedOutputChars = outputChars + formulaChars;
  if (!Number.isSafeInteger(stagedOutputChars))
    throw new LimitExceededError('xlsxFeatureOutputChars', Number.MAX_SAFE_INTEGER);
  // Extra named/list-object blocks repeat cell text, captions and formula strings.
  // Preflight the total, then charge formulas here because the current builder only
  // charges text/captions. The builder will charge the staged text/captions on emit.
  if (!staging.canReserveOutputChars(stagedOutputChars)) return false;
  if (!budget.addCells(table.keptCells)) return false;
  if (!budget.addOutputChars(formulaChars)) return false;
  if (!staging.reserveOutputChars(outputChars)) return false;
  staging.reserveObjects();
  (table as PreparedXlsxTable).caption = caption;
  (table as PreparedXlsxTable).headerRows = headerRows;
  parsed.tables.push(table);
  return true;
}

function applyHiddenTableFlags(
  table: ParsedTable,
  features: Pick<XlsxSheetFeatures, 'hiddenRows' | 'hiddenColumns'>,
  budget: Budget,
): void {
  for (const row of table.rows) {
    budget.tick();
    for (const cell of row) {
      budget.tick();
      const address = cell.address ? parseCellAddress(cell.address, budget) : undefined;
      if (!address) continue;
      if (
        features.hiddenRows.has(address.row) ||
        containsColumn(features.hiddenColumns, address.column, budget)
      )
        cell.hidden = true;
    }
  }
}

function compactRange(
  cells: Map<number, Map<number, ParsedCell>>,
  range: XlsxRange,
  budget: Budget,
  staging: XlsxTextStaging,
): ParsedTable[] {
  staging.reserveObjects();
  const rows = new Map<number, Map<number, ParsedCell>>();
  const rowIndexes: number[] = [];
  for (const [rowNumber, row] of cells) {
    budget.tick();
    if (rowNumber < range.startRow || rowNumber > range.endRow) continue;
    let selected: Map<number, ParsedCell> | undefined;
    for (const [columnNumber, cell] of row) {
      budget.tick();
      if (columnNumber < range.startColumn || columnNumber > range.endColumn) continue;
      if (!selected) {
        staging.reserveObjects();
        selected = new Map<number, ParsedCell>();
      }
      staging.reserveObjects();
      selected.set(columnNumber, cell);
    }
    if (selected) {
      staging.reserveObjects(2);
      rows.set(rowNumber, selected);
      rowIndexes.push(rowNumber);
    }
  }
  rowIndexes.sort((left, right) => {
    budget.tick();
    return left - right;
  });

  interface Region {
    startRow: number;
    endRow: number;
    startColumn: number;
    endColumn: number;
    rows: Map<number, Map<number, ParsedCell>>;
  }
  const regions: Region[] = [];
  let previousRow = 0;
  let previousRegions = new Map<string, Region>();
  for (const rowNumber of rowIndexes) {
    budget.tick();
    const row = rows.get(rowNumber)!;
    const columns: number[] = [];
    for (const column of row.keys()) {
      budget.tick();
      staging.reserveObjects();
      columns.push(column);
    }
    columns.sort((left, right) => {
      budget.tick();
      return left - right;
    });
    staging.reserveObjects();
    const currentRegions = new Map<string, Region>();
    const canExtendPrevious = previousRow + 1 === rowNumber;
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
      const key = `${firstColumn}:${lastColumn}`;
      let region = canExtendPrevious ? previousRegions.get(key) : undefined;
      if (!region) {
        if (regions.length >= MAX_INTEGRATION_OBJECTS)
          throw new LimitExceededError('xlsxFeatureObjects', MAX_INTEGRATION_OBJECTS);
        staging.reserveObjects(2);
        region = {
          startRow: rowNumber,
          endRow: rowNumber,
          startColumn: firstColumn,
          endColumn: lastColumn,
          rows: new Map(),
        };
        regions.push(region);
      } else region.endRow = rowNumber;
      staging.reserveObjects(2);
      region.rows.set(rowNumber, row);
      currentRegions.set(key, region);
      start = end + 1;
    }
    previousRow = rowNumber;
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
    const outputRows: Cell[][] = [];
    let keptCells = 0;
    for (let rowNumber = region.startRow; rowNumber <= region.endRow; rowNumber += 1) {
      budget.tick();
      const row = region.rows.get(rowNumber);
      if (!row) continue;
      staging.reserveObjects();
      const outputRow: Cell[] = [];
      for (let column = region.startColumn; column <= region.endColumn; column += 1) {
        budget.tick();
        const cell = row.get(column);
        if (!cell) continue;
        staging.reserveObjects();
        outputRow.push(copyCell(cell));
        keptCells += 1;
      }
      outputRows.push(outputRow);
    }
    const tableRange = formatRange(
      region.startRow,
      region.startColumn,
      region.endRow,
      region.endColumn,
      budget,
    );
    if (tableRange) tables.push({ rows: outputRows, range: tableRange, keptCells });
  }
  return tables;
}

function copyCell(cell: ParsedCell): Cell {
  return {
    text: cell.text,
    raw: cell.raw,
    address: cell.address,
    ...(cell.hidden ? { hidden: true } : {}),
    ...(cell.rowSpan ? { rowSpan: cell.rowSpan } : {}),
    ...(cell.colSpan ? { colSpan: cell.colSpan } : {}),
    ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
  };
}

function containsColumn(
  ranges: readonly { min: number; max: number }[],
  column: number,
  budget: Budget,
): boolean {
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

function rangeKey(range: XlsxRange): string {
  return `${range.startRow}:${range.startColumn}:${range.endRow}:${range.endColumn}`;
}

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { AbortError, LimitExceededError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Location } from '../../../src/core/model.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { OoxmlParts } from '../../../src/ooxml/parts.js';
import { parseWorksheetCells } from '../../../src/readers/xlsx/cells.js';
import type { ParsedSheetCells } from '../../../src/readers/xlsx/cells.js';
import {
  parseWorkbookDefinedNames,
  parseXlsxSheetFeatureBytes,
  readXlsxPeople,
} from '../../../src/readers/xlsx/features.js';
import type { XlsxDefinedName, XlsxSheetFeatures } from '../../../src/readers/xlsx/features.js';
import { integrateXlsxSheetFeatures } from '../../../src/readers/xlsx/feature-integration.js';
import { XlsxTextStaging } from '../../../src/readers/xlsx/strings.js';
import type { WorkbookSheet } from '../../../src/readers/xlsx/sheets.js';
import { openZip } from '../../../src/zip/index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const sheet: WorkbookSheet = { name: 'Features', state: 'visible', part: 'xl/worksheets/sheet1.xml' };

function context(bytes: Uint8Array) {
  const warnings = new WarningSink();
  const budget = new Budget(DEFAULT_LIMITS, { warnings });
  const ctx = { budget, warnings, path: '' };
  const parts = new OoxmlParts(openZip(bytes, budget), ctx);
  const staging = new XlsxTextStaging(budget);
  return { budget, warnings, ctx, parts, staging };
}

function emptyFeatures(): XlsxSheetFeatures {
  return {
    sheetName: sheet.name,
    sheetPart: sheet.part,
    hiddenRows: new Set(),
    hiddenColumns: [],
    notes: [],
    tables: [],
  };
}

describe('XLSX feature integration preparation', () => {
  it('applies hidden flags and table captions/header counts to existing compact copies', async () => {
    const bytes = fixture('headers_comments_hidden_tables_defined_names.xlsx');
    const { budget, ctx, parts, staging } = context(bytes);
    const sheetBytes = await parts.read(sheet.part);
    const workbookBytes = await parts.read('xl/workbook.xml');
    expect(sheetBytes).toBeDefined();
    expect(workbookBytes).toBeDefined();
    const parsed = parseWorksheetCells(sheetBytes!, [], budget, ctx.warnings, sheet.part, staging);
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const features = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    parseWorkbookDefinedNames(workbookBytes!, [sheet], ctx, staging);
    const result = integrateXlsxSheetFeatures(parsed, sheet, features, [], budget, staging, 'auto');
    expect(parsed.cells.get(1)?.get(2)?.hidden).toBe(true);
    expect(parsed.cells.get(3)?.get(1)?.hidden).toBe(true);
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ caption: 'FeatureTable', headerRows: 1, range: 'A1:B3' });
    expect(result.tables[0]?.rows[0]?.[1]?.hidden).toBe(true);
    expect(result.tables[0]?.rows[2]?.[0]?.hidden).toBe(true);
    expect(result.tables[0]?.rows[0]?.[0]?.text).toBe('__proto__');
    expect(budget.cells).toBe(6);
  });

  it('compacts an unrepresented ListObject from sparse cells and applies its metadata', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: '__proto__', raw: '__proto__' }]])],
        [2, new Map([[1, { row: 2, column: 1, address: 'A2', text: '42', raw: '42' }]])],
      ]),
      tables: [],
      seenCells: 2,
      keptCells: 2,
      skippedCells: 0,
      keptRows: 2,
      skippedRows: 0,
    };
    const features = emptyFeatures();
    features.hiddenRows.add(2);
    features.tables.push({
      id: 7,
      name: 'RawTable',
      displayName: 'CaptionedTable',
      ref: 'A1:A2',
      range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
      headerRowCount: 1,
      columns: ['Column1'],
      path: 'xl/tables/table7.xml',
    });

    const result = integrateXlsxSheetFeatures(parsed, sheet, features, [], budget, staging, 'auto');

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ caption: 'CaptionedTable', headerRows: 1, range: 'A1:A2' });
    expect(result.tables[0]?.rows.map((row) => row[0]?.text)).toEqual(['__proto__', '42']);
    expect(result.tables[0]?.rows[1]?.[0]?.hidden).toBe(true);
    expect(budget.cells).toBe(2);
  });

  it('turns far-apart cells in a named sparse range into bounded compact blocks', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'first', raw: 'first' }]])],
        [90_000, new Map([[26, { row: 90_000, column: 26, address: 'Z90000', text: 'last', raw: 'last' }]])],
      ]),
      tables: [],
      seenCells: 2,
      keptCells: 2,
      skippedCells: 0,
      keptRows: 2,
      skippedRows: 0,
    };
    const features = emptyFeatures();
    const namedRange: XlsxDefinedName = {
      name: 'FarRange',
      sheetName: sheet.name,
      ref: 'A1:Z90000',
      range: { startRow: 1, startColumn: 1, endRow: 90_000, endColumn: 26 },
    };
    const result = integrateXlsxSheetFeatures(parsed, sheet, features, [namedRange], budget, staging, 'auto');
    expect(result.tables).toHaveLength(2);
    expect(result.tables.map((table) => table.range)).toEqual(['A1', 'Z90000']);
    expect(result.tables.map((table) => table.caption)).toEqual(['FarRange', 'FarRange']);
    expect(result.tables.map((table) => table.keptCells)).toEqual([1, 1]);
    expect(result.tables.flatMap((table) => table.rows).map((row) => row.length)).toEqual([1, 1]);
  });

  it('compacts contiguous sparse row runs and keeps separated runs as separate tables', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const cell = (row: number, column: number, address: string, text: string) => ({
      row,
      column,
      address,
      text,
      raw: text,
    });
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [
          1,
          new Map([
            [1, cell(1, 1, 'A1', 'a')],
            [2, cell(1, 2, 'B1', 'b')],
            [5, cell(1, 5, 'E1', 'outside')],
          ]),
        ],
        [
          2,
          new Map([
            [1, cell(2, 1, 'A2', 'c')],
            [2, cell(2, 2, 'B2', 'd')],
          ]),
        ],
        [
          4,
          new Map([
            [1, cell(4, 1, 'A4', 'e')],
            [3, cell(4, 3, 'C4', 'f')],
          ]),
        ],
        [5, new Map([[1, cell(5, 1, 'A5', 'outside')]])],
      ]),
      tables: [],
      seenCells: 7,
      keptCells: 7,
      skippedCells: 0,
      keptRows: 4,
      skippedRows: 0,
    };
    const namedRange: XlsxDefinedName = {
      name: 'Compact',
      sheetName: sheet.name,
      ref: 'A1:C4',
      range: { startRow: 1, startColumn: 1, endRow: 4, endColumn: 3 },
    };

    const result = integrateXlsxSheetFeatures(
      parsed,
      sheet,
      emptyFeatures(),
      [namedRange],
      budget,
      staging,
      false,
    );

    expect(result.tables.map((table) => table.range)).toEqual(['A1:B2', 'A4', 'C4']);
    expect(result.tables.map((table) => table.keptCells)).toEqual([4, 1, 1]);
    expect(result.tables[0]?.rows.map((row) => row.map((value) => value.text))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('preserves formulas when compact cells are copied into a named table', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: '4', raw: 4, formula: 'SUM(1, 3)' }]])],
      ]),
      tables: [],
      seenCells: 1,
      keptCells: 1,
      skippedCells: 0,
      keptRows: 1,
      skippedRows: 0,
    };
    const namedRange: XlsxDefinedName = {
      name: 'FormulaRange',
      sheetName: sheet.name,
      ref: 'A1',
      range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
    };

    const result = integrateXlsxSheetFeatures(
      parsed,
      sheet,
      emptyFeatures(),
      [namedRange],
      budget,
      staging,
      'auto',
    );

    expect(result.tables[0]?.rows[0]?.[0]).toMatchObject({ text: '4', formula: 'SUM(1, 3)' });
    expect(budget.cells).toBe(1);
    expect(budget.outputChars).toBe('SUM(1, 3)'.length);
    expect(budget.addOutputChars('4'.length + 'FormulaRange'.length)).toBe(true);
    expect(budget.outputChars).toBe('SUM(1, 3)'.length + '4'.length + 'FormulaRange'.length);
  });

  it('preflights duplicated formula text before appending a named table block', () => {
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 9 });
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: '4', raw: 4, formula: 'SUM(1, 2)' }]])],
      ]),
      tables: [],
      seenCells: 1,
      keptCells: 1,
      skippedCells: 0,
      keptRows: 1,
      skippedRows: 0,
    };
    const name: XlsxDefinedName = {
      name: 'F',
      sheetName: sheet.name,
      ref: 'A1',
      range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
    };

    const result = integrateXlsxSheetFeatures(parsed, sheet, emptyFeatures(), [name], budget, staging, false);

    expect(result.tables).toHaveLength(0);
    expect(budget.truncated).toBe(true);
    expect(budget.cells).toBe(0);
  });

  it('charges only appended sparse named-range cells and stops at the cell quota', () => {
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 });
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'first', raw: 'first' }]])],
        [90_000, new Map([[26, { row: 90_000, column: 26, address: 'Z90000', text: 'last', raw: 'last' }]])],
      ]),
      tables: [],
      seenCells: 2,
      keptCells: 2,
      skippedCells: 0,
      keptRows: 2,
      skippedRows: 0,
    };
    const namedRange: XlsxDefinedName = {
      name: 'FarRange',
      sheetName: sheet.name,
      ref: 'A1:Z90000',
      range: { startRow: 1, startColumn: 1, endRow: 90_000, endColumn: 26 },
    };

    const result = integrateXlsxSheetFeatures(
      parsed,
      sheet,
      emptyFeatures(),
      [namedRange],
      budget,
      staging,
      'auto',
    );

    expect(result.tables.map((table) => table.range)).toEqual(['A1']);
    expect(budget.cells).toBe(2);
    expect(budget.truncated).toBe(true);
  });

  it('matches list objects by exact numeric range and preserves header metadata', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'header', raw: 'header' }]])],
      ]),
      tables: [{ rows: [[{ text: 'Name', raw: 'Name' }]], range: 'A1', keptCells: 1 }],
      seenCells: 0,
      keptCells: 0,
      skippedCells: 0,
      keptRows: 0,
      skippedRows: 0,
    };
    const features = emptyFeatures();
    features.tables.push({
      id: 4,
      name: '__proto__',
      displayName: 'Safe Caption',
      ref: 'A1',
      range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
      headerRowCount: 0,
      columns: ['__proto__'],
      path: 'xl/tables/table4.xml',
    });
    const result = integrateXlsxSheetFeatures(parsed, sheet, features, [], budget, staging, 'auto');
    expect(result.tables[0]).toMatchObject({ caption: 'Safe Caption', headerRows: 0, range: 'A1' });
    expect(budget.cells).toBe(0);
  });

  it('infers one header row when auto mode sees textual headers followed by numeric data', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map(),
      tables: [
        {
          rows: [[{ text: 'Amount', raw: 'Amount' }], [{ text: '12', raw: 12 }]],
          range: 'A1:A2',
          keptCells: 2,
        },
      ],
      seenCells: 0,
      keptCells: 0,
      skippedCells: 0,
      keptRows: 0,
      skippedRows: 0,
    };

    const result = integrateXlsxSheetFeatures(parsed, sheet, emptyFeatures(), [], budget, staging, 'auto');

    expect(result.tables[0]?.headerRows).toBe(1);
  });

  it('deduplicates defined names by exact range and uses the first name as caption', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'value', raw: 'value' }]])],
      ]),
      tables: [],
      seenCells: 1,
      keptCells: 1,
      skippedCells: 0,
      keptRows: 1,
      skippedRows: 0,
    };
    const range = { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
    const names: XlsxDefinedName[] = [
      { name: 'First', sheetName: sheet.name, ref: 'A1', range },
      { name: 'Second', sheetName: sheet.name, ref: 'A1', range },
      { name: 'OtherSheet', sheetName: 'Elsewhere', ref: 'A1', range },
    ];

    const result = integrateXlsxSheetFeatures(parsed, sheet, emptyFeatures(), names, budget, staging, false);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.caption).toBe('First');
    expect(budget.cells).toBe(1);
  });

  it('adds a named caption to an already compact table without charging duplicate cells', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'header', raw: 'header' }]])],
      ]),
      tables: [{ rows: [[{ text: 'header', raw: 'header' }]], range: 'A1', keptCells: 1 }],
      seenCells: 0,
      keptCells: 0,
      skippedCells: 0,
      keptRows: 0,
      skippedRows: 0,
    };
    const name: XlsxDefinedName = {
      name: 'ExistingName',
      sheetName: sheet.name,
      ref: 'A1',
      range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
    };

    const result = integrateXlsxSheetFeatures(parsed, sheet, emptyFeatures(), [name], budget, staging, false);

    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]).toMatchObject({ caption: 'ExistingName', range: 'A1' });
    expect(budget.cells).toBe(0);
  });

  it('truncates before appending a named block that exceeds the output character budget', () => {
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 2 });
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'value', raw: 'value' }]])],
      ]),
      tables: [],
      seenCells: 1,
      keptCells: 1,
      skippedCells: 0,
      keptRows: 1,
      skippedRows: 0,
    };
    const name: XlsxDefinedName = {
      name: 'Range',
      sheetName: sheet.name,
      ref: 'A1',
      range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
    };

    const result = integrateXlsxSheetFeatures(parsed, sheet, emptyFeatures(), [name], budget, staging, false);

    expect(result.tables).toHaveLength(0);
    expect(budget.truncated).toBe(true);
    expect(budget.cells).toBe(0);
  });

  it('throws caller-requested cell/output limits and propagates cancellation', () => {
    const range = { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
    const name: XlsxDefinedName = { name: 'Range', sheetName: sheet.name, ref: 'A1', range };
    const makeParsed = (): ParsedSheetCells => ({
      cells: new Map([
        [1, new Map([[1, { row: 1, column: 1, address: 'A1', text: 'value', raw: 'value' }]])],
      ]),
      tables: [],
      seenCells: 1,
      keptCells: 1,
      skippedCells: 0,
      keptRows: 1,
      skippedRows: 0,
    });

    const cellBudget = new Budget({ ...DEFAULT_LIMITS, cells: 0 }, { onLimit: 'throw' });
    expect(() =>
      integrateXlsxSheetFeatures(
        makeParsed(),
        sheet,
        emptyFeatures(),
        [name],
        cellBudget,
        new XlsxTextStaging(cellBudget),
        false,
      ),
    ).toThrow(LimitExceededError);

    const textBudget = new Budget({ ...DEFAULT_LIMITS, outputChars: 2 }, { onLimit: 'throw' });
    expect(() =>
      integrateXlsxSheetFeatures(
        makeParsed(),
        sheet,
        emptyFeatures(),
        [name],
        textBudget,
        new XlsxTextStaging(textBudget),
        false,
      ),
    ).toThrow(LimitExceededError);

    const controller = new AbortController();
    controller.abort();
    const cancelledBudget = new Budget(DEFAULT_LIMITS, { signal: controller.signal });
    expect(() =>
      integrateXlsxSheetFeatures(
        makeParsed(),
        sheet,
        emptyFeatures(),
        [name],
        cancelledBudget,
        new XlsxTextStaging(cancelledBudget),
        false,
      ),
    ).toThrow(AbortError);
  });

  it('returns notes in cell order with sheet, path, and single-cell range locations', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const staging = new XlsxTextStaging(budget);
    const parsed: ParsedSheetCells = {
      cells: new Map(),
      tables: [],
      seenCells: 0,
      keptCells: 0,
      skippedCells: 0,
      keptRows: 0,
      skippedRows: 0,
    };
    const features = emptyFeatures();
    features.notes.push(
      { address: 'B3', text: 'later', author: 'Private', path: 'xl/comments1.xml' },
      { address: 'A2', text: 'earlier', path: 'xl/threadedComments/comments.xml' },
      { address: 'not-a-cell', text: 'ignored', path: 'xl/comments1.xml' },
    );
    const notes = integrateXlsxSheetFeatures(
      parsed,
      sheet,
      features,
      [],
      budget,
      staging,
      false,
      false,
    ).notes;
    expect(notes).toEqual([
      {
        text: 'earlier',
        loc: { sheet: 'Features', path: 'xl/threadedComments/comments.xml', range: 'A2' },
      },
      {
        text: 'later',
        loc: { sheet: 'Features', path: 'xl/comments1.xml', range: 'B3' },
      },
    ] satisfies Array<{ text: string; author?: string; loc: Location }>);
  });
});

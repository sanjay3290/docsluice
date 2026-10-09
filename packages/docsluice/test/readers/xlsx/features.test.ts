import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ParsedCell } from '../../../src/readers/xlsx/cells.js';
import {
  applyHiddenCellFlags,
  inferHeaderRows,
  parseA1RangeReference,
  parseWorkbookDefinedNames,
  parseXlsxSheetFeatureBytes,
  readXlsxPeople,
} from '../../../src/readers/xlsx/features.js';
import { XlsxTextStaging } from '../../../src/readers/xlsx/strings.js';
import type { WorkbookSheet } from '../../../src/readers/xlsx/sheets.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { OoxmlParts } from '../../../src/ooxml/parts.js';
import { openZip } from '../../../src/zip/index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function featureContext(bytes: Uint8Array, outputChars = DEFAULT_LIMITS.outputChars) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, outputChars }, { warnings });
  const ctx = { budget, warnings, path: '' };
  const parts = new OoxmlParts(openZip(bytes, budget), ctx);
  return { budget, warnings, ctx, parts, staging: new XlsxTextStaging(budget) };
}

const sheet: WorkbookSheet = {
  name: 'Features',
  state: 'visible',
  part: 'xl/worksheets/sheet1.xml',
};

describe('XLSX feature metadata', () => {
  it('reads hidden ranges, classic comments, table metadata, and scoped defined names', async () => {
    const { parts, ctx, staging } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const workbookBytes = await parts.read('xl/workbook.xml');
    const sheetBytes = await parts.read(sheet.part);
    expect(workbookBytes).toBeDefined();
    expect(sheetBytes).toBeDefined();
    const definedNames = parseWorkbookDefinedNames(workbookBytes!, [sheet], ctx, staging);
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const features = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    expect([...features.hiddenRows]).toEqual([3]);
    expect(features.hiddenColumns).toEqual([{ min: 2, max: 2 }]);
    expect(features.notes).toEqual([
      {
        address: 'A2',
        text: 'Self-authored note text.',
        author: 'Fixture Author',
        path: 'xl/comments1.xml',
      },
    ]);
    expect(features.tables).toEqual([
      {
        id: 1,
        name: 'FeatureTable',
        displayName: 'FeatureTable',
        ref: 'A1:B3',
        range: { startRow: 1, startColumn: 1, endRow: 3, endColumn: 2 },
        headerRowCount: 1,
        columns: ['__proto__', 'Label'],
        path: 'xl/tables/table1.xml',
      },
    ]);
    expect(definedNames).toEqual([
      {
        name: 'FeatureRange',
        sheetName: 'Features',
        ref: 'Features!A1:B2',
        range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
      },
    ]);
  });

  it('flags only cells covered by hidden rows or hidden column intervals', async () => {
    const { parts, ctx, staging, budget } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const sheetBytes = await parts.read(sheet.part);
    expect(sheetBytes).toBeDefined();
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const features = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    const cells = new Map<number, Map<number, ParsedCell>>([
      [
        1,
        new Map([
          [1, { row: 1, column: 1, address: 'A1', text: 'header', raw: 'header' }],
          [2, { row: 1, column: 2, address: 'B1', text: 'Label', raw: 'Label' }],
        ]),
      ],
      [3, new Map([[1, { row: 3, column: 1, address: 'A3', text: 'hidden', raw: 'hidden' }]])],
    ]);
    applyHiddenCellFlags(cells, features, budget);
    expect(cells.get(1)?.get(1)?.hidden).toBeUndefined();
    expect(cells.get(1)?.get(2)?.hidden).toBe(true);
    expect(cells.get(3)?.get(1)?.hidden).toBe(true);
  });

  it('ignores invalid zero-based hidden ranges and reports a scoped warning', async () => {
    const { parts, ctx, staging, warnings } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const sheetBytes = await parts.read(sheet.part);
    expect(sheetBytes).toBeDefined();
    const altered = new TextEncoder().encode(
      new TextDecoder()
        .decode(sheetBytes)
        .replace('min="2" max="2"', 'min="0" max="2"')
        .replace('r="3" hidden="1"', 'r="0" hidden="1"'),
    );
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const parsed = await parseXlsxSheetFeatureBytes(altered, sheet, parts, people, ctx, staging, true);
    expect([...parsed.hiddenRows]).toEqual([]);
    expect(parsed.hiddenColumns).toEqual([]);
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.loc?.path).toBe(sheet.part);
    expect(warnings.warnings[0]?.message).not.toMatch(/r=|hidden|0|2/);
  });

  it('omits comment authors when metadata is disabled but retains note text and range', async () => {
    const { parts, ctx, staging } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const sheetBytes = await parts.read(sheet.part);
    expect(sheetBytes).toBeDefined();
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, false);
    const parsed = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, false);
    expect(parsed.notes).toEqual([
      { address: 'A2', text: 'Self-authored note text.', path: 'xl/comments1.xml' },
    ]);
  });

  it('does not charge classic author metadata against the output-text quota', async () => {
    const { parts, ctx, staging } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
      36,
    );
    const sheetBytes = await parts.read(sheet.part);
    expect(sheetBytes).toBeDefined();
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const parsed = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    expect(parsed.notes.map((note) => note.text)).toEqual(['Self-authored note text.']);
    expect(staging.reservedOutputChars).toBe(36);
  });

  it('detects a textual header only when later rows have non-text or differing types', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const rows = [
      [
        { text: 'Name', raw: 'Name', valueType: 'text' as const },
        { text: 'Amount', raw: 'Amount', valueType: 'text' as const },
      ],
      [
        { text: 'Ada', raw: 'Ada', valueType: 'text' as const },
        { text: '12', raw: 12, valueType: 'number' as const },
      ],
    ];
    expect(inferHeaderRows(rows, 'auto', budget)).toBe(1);
    expect(inferHeaderRows(rows, true, budget)).toBe(1);
    expect(inferHeaderRows(rows, false, budget)).toBe(0);
    expect(
      inferHeaderRows(
        [rows[0]!, rows[1]!.map((cell) => ({ ...cell, raw: String(cell.raw), valueType: 'text' as const }))],
        'auto',
        budget,
      ),
    ).toBe(0);
    expect(inferHeaderRows([[{ text: 'only row', raw: 'only row' }], []], 'auto', budget)).toBe(0);
  });

  it('parses bounded absolute A1 ranges with optional sheet qualifiers', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    expect(parseA1RangeReference("'Quarter 1'!$A$1:$Z$90000", budget)).toEqual({
      sheetName: 'Quarter 1',
      ref: "'Quarter 1'!A1:Z90000",
      range: { startRow: 1, startColumn: 1, endRow: 90_000, endColumn: 26 },
    });
    for (const value of [
      'XFE1',
      'A0',
      'A1:B0',
      'A:A',
      '1:3',
      '[Book.xlsx]Sheet1!A1',
      "'[Book.xlsx]Sheet1'!A1",
      'A1,B2',
      'A1:B2:C3',
    ])
      expect(parseA1RangeReference(value, budget)).toBeUndefined();
  });

  it('uses relationship namespace identity rather than a literal prefix', async () => {
    const { parts, ctx, staging } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const original = await parts.read(sheet.part);
    expect(original).toBeDefined();
    const aliased = new TextEncoder().encode(
      new TextDecoder().decode(original).replace('xmlns:r=', 'xmlns:rel=').replaceAll('r:id=', 'rel:id='),
    );
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const features = await parseXlsxSheetFeatureBytes(aliased, sheet, parts, people, ctx, staging, true);
    expect(features.tables.map((table) => table.name)).toEqual(['FeatureTable']);
  });

  it('does not accept similarly named elements from extension namespaces', async () => {
    const { parts, ctx, staging, warnings } = featureContext(
      fixture('headers_comments_hidden_tables_defined_names.xlsx'),
    );
    const original = await parts.read(sheet.part);
    expect(original).toBeDefined();
    const text = new TextDecoder().decode(original);
    const altered = new TextEncoder().encode(
      text
        .replace('<tableParts', '<ext:tableParts xmlns:ext="urn:fixture-extension"')
        .replace('</tableParts>', '</ext:tableParts>'),
    );
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const features = await parseXlsxSheetFeatureBytes(altered, sheet, parts, people, ctx, staging, true);
    expect(features.tables).toEqual([]);
    expect(warnings.warnings).toHaveLength(0);
  });

  it('skips unsupported defined-name expressions with a static warning', () => {
    const { ctx, warnings } = featureContext(fixture('headers_comments_hidden_tables_defined_names.xlsx'));
    const xml = new TextEncoder().encode(
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><definedNames>' +
        '<definedName name="Bad">OFFSET(A1,1,2)</definedName><definedName name="Good">Features!A1</definedName>' +
        '</definedNames></workbook>',
    );
    expect(parseWorkbookDefinedNames(xml, [sheet], ctx)).toEqual([
      {
        name: 'Good',
        sheetName: 'Features',
        ref: 'Features!A1',
        range: { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 },
      },
    ]);
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).not.toMatch(/OFFSET|A1/);
    expect(warnings.warnings[0]?.loc?.path).toBeUndefined();
  });

  it('reads threaded comment relationships and person display names from a dedicated fixture', async () => {
    const { parts, ctx, staging } = featureContext(fixture('threaded_comments.xlsx'));
    const workbookBytes = await parts.read('xl/workbook.xml');
    const sheetBytes = await parts.read(sheet.part);
    expect(workbookBytes).toBeDefined();
    expect(sheetBytes).toBeDefined();
    expect(parseWorkbookDefinedNames(workbookBytes!, [sheet], ctx, staging)).toEqual([
      {
        name: 'FeatureRange',
        sheetName: 'Features',
        ref: 'Features!A1:B2',
        range: { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 },
        localSheetId: 0,
      },
    ]);
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    const parsed = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    expect(parsed.notes).toEqual([
      {
        address: 'A2',
        text: 'Self-authored note text.',
        author: 'Fixture Author',
        path: 'xl/comments1.xml',
      },
      {
        address: 'A3',
        text: 'Threaded comment',
        author: 'Threaded Author',
        path: 'xl/threadedComments/threadedComment1.xml',
      },
      {
        address: 'A3',
        text: 'Thread reply',
        author: 'Reply Author',
        path: 'xl/threadedComments/threadedComment1.xml',
      },
    ]);
  });

  it('does not let unused people names crowd out note text under a tight output quota', async () => {
    const { parts, ctx, staging } = featureContext(fixture('threaded_comments.xlsx'), 64);
    const sheetBytes = await parts.read(sheet.part);
    expect(sheetBytes).toBeDefined();
    const people = await readXlsxPeople(parts, 'xl/workbook.xml', ctx, staging, true);
    expect(people.get('{unused-person}')).toBe('Unused Person');
    expect(staging.reservedOutputChars).toBe(0);
    const parsed = await parseXlsxSheetFeatureBytes(sheetBytes!, sheet, parts, people, ctx, staging, true);
    expect(parsed.notes.map((note) => note.text)).toEqual([
      'Self-authored note text.',
      'Threaded comment',
      'Thread reply',
    ]);
    expect(staging.reservedOutputChars).toBe(64);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { openZip } from '../../../src/zip/index.js';
import { parseCellAddress } from '../../../src/readers/xlsx/addresses.js';
import { parseWorksheetCells } from '../../../src/readers/xlsx/cells.js';
import { parseXlsx, xlsxReader } from '../../../src/readers/xlsx/index.js';
import { readSharedStrings, XlsxTextStaging } from '../../../src/readers/xlsx/strings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ParsedXlsxWorkbook } from '../../../src/readers/xlsx/index.js';
import { makeZip } from '../../helpers/zip.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

function createContext(bytes: Uint8Array, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  const options = { metadata: true } as ResolvedOptions;
  const out = new DocBuilder(
    'xlsx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    budget,
    options,
  );
  const ctx: ReadContext = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
    zip: openZip(bytes, budget),
  };
  return { ctx, budget, warnings, out };
}

function sheetByName(parsed: ParsedXlsxWorkbook, name: string) {
  return parsed.sheets.find((sheet) => sheet.name === name)!;
}

function largeWorkbook(rowCount: number): Uint8Array {
  const xml = new TextEncoder();
  let rows = '';
  for (let row = 1; row <= rowCount; row += 1)
    rows += `<row r="${row}"><c r="A${row}" t="n"><v>${row}</v></c></row>`;
  return makeZip([
    {
      name: '_rels/.rels',
      data: xml.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: xml.encode(
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Rows" sheetId="1" r:id="sheet"/></sheets></workbook>',
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: xml.encode(
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: xml.encode(
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`,
      ),
    },
  ]);
}

describe('xlsx sparse sheets and strings', () => {
  it('uses workbook sheet order, resolves states and string/cell types', async () => {
    const bytes = fixture('basics_order_states_strings_types_merges.xlsx');
    const { ctx, warnings } = createContext(bytes);
    const parsed = await parseXlsx(ctx);
    expect(parsed.sheets.map((sheet) => [sheet.name, sheet.part])).toEqual([
      ['Main', 'xl/worksheets/sheet10.xml'],
      ['Hidden', 'xl/worksheets/sheet2.xml'],
      ['Secret', 'xl/worksheets/sheet1.xml'],
      ['__proto__', 'xl/worksheets/sheet3.xml'],
    ]);
    expect(parsed.sheets.map((sheet) => sheet.state)).toEqual(['visible', 'hidden', 'very', 'visible']);
    const main = sheetByName(parsed, 'Main');
    expect(main.cells.get(1)?.get(1)?.text).toBe('plain shared text');
    expect(main.cells.get(1)?.get(2)?.text).toBe('inline text');
    expect(main.cells.get(2)?.get(1)?.text).toBe('rich string');
    expect(main.cells.get(2)?.get(2)).toMatchObject({ text: 'TRUE', raw: true, address: 'B2' });
    expect(main.cells.get(2)?.get(3)).toMatchObject({ text: '#N/A', address: 'C2' });
    expect(main.cells.get(2)?.get(4)).toMatchObject({
      text: 'cached string',
      raw: 'cached string',
      address: 'D2',
    });
    expect(main.cells.get(2)?.get(5)?.text.startsWith('2026-')).toBe(true);
    expect(main.cells.get(3)?.get(5)).toMatchObject({
      text: 'merged anchor',
      rowSpan: 2,
      colSpan: 2,
      address: 'E3',
    });
    expect(warnings.warnings).toEqual([]);
  });

  it('ignores lying dimensions and keeps distant cells in compact tables', async () => {
    const bytes = fixture('sparse_a1_z90000_lying_dimension.xlsx');
    const warm = createContext(bytes);
    await parseXlsx(warm.ctx);
    const start = performance.now();
    const parsed = await parseXlsx(createContext(bytes).ctx);
    const elapsed = performance.now() - start;
    const sheet = parsed.sheets[0]!;
    expect(sheet.tables).toHaveLength(2);
    expect(sheet.tables.map((table) => table.range)).toEqual(['A1', 'Z90000']);
    expect(sheet.tables.flatMap((table) => table.rows.flat().map((cell) => cell.address))).toEqual([
      'A1',
      'Z90000',
    ]);
    expect(elapsed).toBeLessThan(100);
  });

  it('extracts a 50,000-row worksheet within the reader performance budget', async () => {
    const bytes = largeWorkbook(50_000);
    const start = performance.now();
    const parsed = await parseXlsx(createContext(bytes).ctx);
    const elapsed = performance.now() - start;
    expect(parsed.sheets[0]?.seenCells).toBe(50_000);
    expect(parsed.sheets[0]?.tables[0]?.rows).toHaveLength(50_000);
    expect(parsed.sheets[0]?.cells.get(50_000)?.get(1)?.address).toBe('A50000');
    expect(elapsed).toBeLessThan(3_000);
  });

  it('keeps a 100,000-row ordinary worksheet under the independent reader object cap', async () => {
    const parsed = await parseXlsx(createContext(largeWorkbook(100_000)).ctx);
    expect(parsed.sheets[0]?.seenCells).toBe(100_000);
    expect(parsed.sheets[0]?.tables[0]?.rows).toHaveLength(100_000);
    expect(parsed.sheets[0]?.cells.get(100_000)?.get(1)?.address).toBe('A100000');
  });

  it('recovers an out-of-range shared-string index as an empty cell with a warning', async () => {
    const { ctx, warnings } = createContext(fixture('hostile_shared_string_index_out_of_range.xlsx'));
    const parsed = await parseXlsx(ctx);
    expect(parsed.sheets[0]?.cells.get(1)?.get(1)).toMatchObject({ text: '', raw: '', address: 'A1' });
    expect(warnings.warnings.some((warning) => warning.code === 'UNREADABLE_PART')).toBe(true);
  });

  it('does not treat empty or whitespace shared-string indexes as index zero', () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const parsed = parseWorksheetCells(
      new TextEncoder().encode(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v></v></c><c r="B1" t="s"><v>   </v></c><c r="C1" t="s"><v> 0 </v></c></row></sheetData></worksheet>',
      ),
      ['first string'],
      budget,
      warnings,
    );
    expect(parsed.cells.get(1)?.get(1)?.text).toBe('');
    expect(parsed.cells.get(1)?.get(2)?.text).toBe('');
    expect(parsed.cells.get(1)?.get(3)?.text).toBe('first string');
    expect(
      warnings.warnings.filter((warning) => warning.message.includes('shared string index')),
    ).toHaveLength(1);
  });

  it('retains hidden state internally and emits a hidden-content warning through the adapter', async () => {
    const { ctx, out, warnings } = createContext(fixture('basics_order_states_strings_types_merges.xlsx'));
    await xlsxReader.read(ctx);
    const result = out.finish();
    const sections = result.blocks.filter((block) => block.kind === 'section');
    expect(sections.map((section) => section.loc.sheet)).toEqual(['Main', 'Hidden', 'Secret', '__proto__']);
    expect(warnings.warnings.filter((warning) => warning.code === 'HIDDEN_CONTENT')).toHaveLength(2);
    expect(
      (await parseXlsx(createContext(fixture('basics_order_states_strings_types_merges.xlsx')).ctx)).sheets[2]
        ?.state,
    ).toBe('very');
    expect(sections.map((section) => section.hidden)).toEqual([undefined, true, 'very', undefined]);
  });

  it('splits contiguous column regions and charges hostile cells', () => {
    const xml = new TextEncoder().encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="n"><v>1</v></c><c r="Z1" t="n"><v>2</v></c></row></sheetData></worksheet>',
    );
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const parsed = parseWorksheetCells(xml, [], budget, warnings);
    expect(parsed.tables.map((table) => table.range)).toEqual(['A1']);
    expect(parsed.skippedCells).toBe(1);
    expect(warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
  });

  it('flattens inline rich text without phonetic annotations and caps index warnings', () => {
    const xml = new TextEncoder().encode(
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><r><t>text</t></r><rPh sb="0" eb="4"><t>phonetic</t></rPh></is></c><c r="B1" t="s"><v>8</v></c><c r="C1" t="s"><v>8</v></c></row></sheetData></worksheet>',
    );
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const parsed = parseWorksheetCells(xml, ['stored'], budget, warnings);
    expect(parsed.cells.get(1)?.get(1)?.text).toBe('text');
    expect(warnings.warnings.filter((warning) => warning.code === 'UNREADABLE_PART')).toHaveLength(1);
  });

  it('ignores extension elements that resemble worksheet cells or shared strings', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const warnings = new WarningSink();
    const strings = readSharedStrings(
      new TextEncoder().encode(
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><ext><si><t>ignored</t></si></ext><si><ext><t>also ignored</t></ext><t>kept</t><r><t> rich</t></r><rPh><t>phonetic</t></rPh></si></sst>',
      ),
      budget,
      warnings,
    );
    const sheet = parseWorksheetCells(
      new TextEncoder().encode(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>visible</t></is></c></row><ext><sheetData><row r="2"><c r="A2"><v>injected</v></c></row></sheetData></ext></sheetData></worksheet>',
      ),
      strings,
      budget,
      warnings,
    );
    expect(strings).toEqual(['kept rich']);
    expect([...sheet.cells.values()].flatMap((row) => [...row.values()].map((cell) => cell.address))).toEqual(
      ['A1'],
    );
  });

  it('keeps shared-string staging out of the worksheet cell and output counters', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const strings = readSharedStrings(
      new TextEncoder().encode(
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>not yet emitted</t></si></sst>',
      ),
      budget,
      warnings,
    );
    expect(strings).toEqual(['not yet emitted']);
    expect(budget.cells).toBe(0);
    expect(budget.outputChars).toBe(0);
  });

  it('preserves high shared-string indexes and lets unused strings avoid caller output limits', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1, outputChars: 2 }, { warnings });
    const staging = new XlsxTextStaging(budget);
    const strings = readSharedStrings(
      new TextEncoder().encode(
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>unused text</t></si><si><t>also unused</t></si><si><t>ok</t></si></sst>',
      ),
      budget,
      warnings,
      undefined,
      staging,
    );
    const parsed = parseWorksheetCells(
      new TextEncoder().encode(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>2</v></c></row></sheetData></worksheet>',
      ),
      strings,
      budget,
      warnings,
      undefined,
      staging,
    );
    expect(strings).toEqual(['unused text', 'also unused', 'ok']);
    expect(parsed.cells.get(1)?.get(1)?.text).toBe('ok');
    expect(parsed.keptCells).toBe(1);
    expect(budget.cells).toBe(1);
    expect(budget.outputChars).toBe(0);
  });

  it('resolves relationship attributes by namespace URI even when the prefix is aliased', async () => {
    const encoder = new TextEncoder();
    const bytes = makeZip([
      {
        name: '_rels/.rels',
        data: encoder.encode(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
        ),
      },
      {
        name: 'xl/workbook.xml',
        data: encoder.encode(
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:alias="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Alias" sheetId="1" alias:id="sheet"/></sheets></workbook>',
        ),
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        data: encoder.encode(
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
      },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: encoder.encode(
          '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
        ),
      },
    ]);
    const parsed = await parseXlsx(createContext(bytes).ctx);
    expect(parsed.sheets.map((sheet) => sheet.name)).toEqual(['Alias']);
    expect(parsed.sheets[0]?.cells.get(1)?.get(1)?.text).toBe('1');
  });

  it('truncates cell text before retaining values beyond outputChars', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 1 }, { warnings });
    const parsed = parseWorksheetCells(
      new TextEncoder().encode(
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="str"><v>too long</v></c></row></sheetData></worksheet>',
      ),
      [],
      budget,
      warnings,
    );
    expect(parsed.keptCells).toBe(0);
    expect(parsed.skippedCells).toBe(1);
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
  });

  it('marks a nonempty workbook title that cannot fit outputChars as truncated', async () => {
    const { ctx, budget, warnings } = createContext(
      fixture('basics_order_states_strings_types_merges.xlsx'),
      { outputChars: 0 },
    );
    const parsed = await parseXlsx(ctx);
    expect(parsed.sheets).toEqual([]);
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
  });

  it('validates A1 bounds and scans rich inline text iteratively', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    expect(parseCellAddress('XFD1048576', budget)).toMatchObject({ row: 1_048_576, column: 16_384 });
    expect(parseCellAddress('XFE1', budget)).toBeUndefined();
    expect(parseCellAddress('A0', budget)).toBeUndefined();
  });
});

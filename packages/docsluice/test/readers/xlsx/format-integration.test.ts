import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { openZip } from '../../../src/zip/index.js';
import { parseXlsx, xlsxReader } from '../../../src/readers/xlsx/index.js';
import { makeZip } from '../../helpers/zip.js';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

type ReferenceCase = {
  id: string;
  format_code: string;
  value: string;
  date_system: 1900 | 1904;
  family: string;
  kind: 'text' | 'number';
  libreoffice_display: string;
};

const numfmtReference = JSON.parse(
  readFileSync(new URL('./fixtures/numfmt/libreoffice-reference.json', import.meta.url), 'utf8'),
) as { source: { application: string }; cases: ReferenceCase[] };

function workbook(stylesXml: string | undefined, cellsXml: string, date1904?: string): Uint8Array {
  const encoder = new TextEncoder();
  const workbookPr = date1904 === undefined ? '' : `<workbookPr date1904="${date1904}"/>`;
  const files = [
    {
      name: '_rels/.rels',
      data: encoder.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="office" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        `<workbook xmlns="${MAIN}" xmlns:r="${OFFICE_REL}">${workbookPr}<sheets><sheet name="Formatted" sheetId="1" r:id="sheet"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/>${stylesXml === undefined ? '' : `<Relationship Id="styles" Type="${OFFICE_REL}/styles" Target="styles.xml"/>`}</Relationships>`,
      ),
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      data: encoder.encode(
        `<worksheet xmlns="${MAIN}"><sheetData><row r="1">${cellsXml}</row></sheetData></worksheet>`,
      ),
    },
  ];
  if (stylesXml !== undefined) files.push({ name: 'xl/styles.xml', data: encoder.encode(stylesXml) });
  return makeZip(files);
}

function context(bytes: Uint8Array, limits: Partial<typeof DEFAULT_LIMITS> = {}) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  const options = { metadata: false } as ResolvedOptions;
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

const styledFormats = `<styleSheet xmlns="${MAIN}"><numFmts count="5"><numFmt numFmtId="164" formatCode="0.00"/><numFmt numFmtId="165" formatCode="0%"/><numFmt numFmtId="166" formatCode="# ?/?"/><numFmt numFmtId="167" formatCode="&quot;$&quot;#,##0.00"/><numFmt numFmtId="168" formatCode="0.00;[Red](0.00);&quot;zero&quot;;&quot;text:&quot;@"/></numFmts><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="168"/><xf numFmtId="14"/></cellXfs></styleSheet>`;

describe('XLSX number format reader integration', () => {
  it('formats styled numeric and string cells through their workbook styles relationship', async () => {
    const bytes = workbook(
      styledFormats,
      '<c r="A1" s="1"><v>1.2</v></c><c r="B1" s="2"><v>0.25</v></c><c r="C1" s="3"><v>0.25</v></c><c r="D1" s="4"><v>1234.5</v></c><c r="E1" s="5"><v>12.5</v></c><c r="F1" s="5" t="str"><v>Ada</v></c><c r="G1" s="6"><v>45292</v></c>',
    );
    const { ctx, budget } = context(bytes);
    const parsed = await parseXlsx(ctx);
    const row = parsed.sheets[0]?.cells.get(1);
    expect(row).toBeDefined();
    if (!row) throw new Error('Expected first worksheet row');
    expect(row.get(1)).toMatchObject({ text: '1.20', raw: 1.2 });
    expect(row.get(2)).toMatchObject({ text: '25%', raw: 0.25 });
    expect(row.get(3)).toMatchObject({ text: ' 1/4', raw: 0.25 });
    expect(row.get(4)).toMatchObject({ text: '$1,234.50', raw: 1234.5 });
    expect(row.get(5)).toMatchObject({ text: '12.50', raw: 12.5 });
    expect(row.get(6)).toMatchObject({ text: 'text:Ada', raw: 'Ada' });
    expect(row.get(7)).toMatchObject({ text: '01-01-24', raw: 45292 });
    expect(budget.outputChars).toBe(0);

    const readerContext = context(bytes);
    await xlsxReader.read(readerContext.ctx);
    const result = readerContext.out.finish();
    const section = result.blocks.find((block) => block.kind === 'section');
    const table =
      section?.kind === 'section' ? section.blocks.find((block) => block.kind === 'table') : undefined;
    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') {
      expect(table.rows[0]?.map((cell) => cell.text)).toEqual([
        '1.20',
        '25%',
        ' 1/4',
        '$1,234.50',
        '12.50',
        'text:Ada',
        '01-01-24',
      ]);
      expect(table.rows[0]?.map((cell) => cell.raw)).toEqual([1.2, 0.25, 0.25, 1234.5, 12.5, 'Ada', 45292]);
    }
  });

  it.each([
    ['0', '1899-12-31'],
    ['1', '1904-01-01'],
    ['true', '1904-01-01'],
  ])('uses workbookPr date1904=%s for built-in date cells', async (date1904, expected) => {
    const bytes = workbook(
      `<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      '<c r="A1" s="1"><v>0</v></c>',
      date1904,
    );
    const parsed = await parseXlsx(context(bytes).ctx);
    expect(parsed.sheets[0]?.cells.get(1)?.get(1)).toMatchObject({ text: expected, raw: 0 });
  });

  it('defaults a missing workbookPr to the 1900 date system', async () => {
    const bytes = workbook(
      `<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      '<c r="A1" s="1"><v>0</v></c>',
    );
    const parsed = await parseXlsx(context(bytes).ctx);
    expect(parsed.sheets[0]?.cells.get(1)?.get(1)).toMatchObject({ text: '1899-12-31', raw: 0 });
  });

  it('uses General with a generic warning for invalid style indexes', async () => {
    const bytes = workbook(
      `<styleSheet xmlns="${MAIN}"><cellXfs count="1"><xf numFmtId="0"/></cellXfs></styleSheet>`,
      '<c r="A1" s="-1"><v>12.5</v></c><c r="B1" s="100000000000000000000"><v>13.5</v></c><c r="C1" s="nonnumeric"><v>14.5</v></c>',
    );
    const { ctx, warnings } = context(bytes);
    const parsed = await parseXlsx(ctx);
    const row = parsed.sheets[0]?.cells.get(1);
    expect(row).toBeDefined();
    if (!row) throw new Error('Expected first worksheet row');
    expect(row.get(1)).toMatchObject({ text: '12.5', raw: 12.5 });
    expect(row.get(2)).toMatchObject({ text: '13.5', raw: 13.5 });
    expect(row.get(3)).toMatchObject({ text: '14.5', raw: 14.5 });
    const unreadable = warnings.warnings.filter((warning) => warning.code === 'UNREADABLE_PART');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.message).not.toMatch(/100000000000000000000|nonnumeric/);
  });

  it('matches the LibreOffice-built XLSX corpus across its supported number-format cases', async () => {
    expect(numfmtReference.source.application).toContain('LibreOfficeDev 26.8.0.0.alpha0');
    let comparedCases = 0;
    for (const dateSystem of [1900, 1904] as const) {
      const bytes = new Uint8Array(
        readFileSync(
          new URL(`./fixtures/numfmt/workbooks/number-format-cases-${dateSystem}.xlsx`, import.meta.url),
        ),
      );
      const parsed = await parseXlsx(context(bytes).ctx);
      const sheet = parsed.sheets[0];
      expect(sheet).toBeDefined();
      const actual = new Map<string, string>();
      for (const [rowIndex, row] of sheet!.cells) {
        if (rowIndex === 1) continue;
        const id = row.get(1)?.text;
        const display = row.get(5)?.text;
        if (id !== undefined && display !== undefined) actual.set(id, display);
      }
      const cases = numfmtReference.cases.filter((item) => {
        if (item.date_system !== dateSystem) return false;
        const early1900Date =
          dateSystem === 1900 &&
          (item.family === 'date' || item.family.startsWith('date-system-')) &&
          Number(item.value) < 61;
        const widthPaddingDifference = item.format_code.includes('_');
        return !early1900Date && !widthPaddingDifference;
      });
      comparedCases += cases.length;
      expect(actual.size).toBeGreaterThanOrEqual(cases.length);
      for (const item of cases)
        expect(actual.get(item.id), `${item.id} ${item.format_code} ${item.value}`).toBe(
          item.libreoffice_display,
        );
    }
    expect(comparedCases).toBeGreaterThan(150);
  });

  it('formats built-in and custom cells in the LibreOffice-saved XLSX corpus', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/biff8-source-lo.xlsx', import.meta.url)));
    const parsed = await parseXlsx(context(bytes).ctx);
    const visible = parsed.sheets.find((sheet) => sheet.name === 'Visible')!;
    expect(visible.cells.get(2)?.get(2)).toMatchObject({ text: '42.25', raw: 42.25 });
    expect(visible.cells.get(4)?.get(2)).toMatchObject({ text: '1900-03-01', raw: 61 });
    expect(visible.cells.get(5)?.get(2)).toMatchObject({ text: '-7.50', raw: -7.5 });
  });

  it('applies output limits to the formatted value and stages no raw XML output', async () => {
    const bytes = workbook(
      `<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="164" formatCode="&quot;prefix &quot;@"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      '<c r="A1" s="1" t="str"><v>A</v></c>',
    );
    const { ctx, budget, warnings } = context(bytes, { outputChars: 10 });
    const parsed = await parseXlsx(ctx);
    expect(parsed.sheets[0]?.keptCells).toBe(0);
    expect(parsed.sheets[0]?.skippedCells).toBe(1);
    expect(budget.outputChars).toBe(0);
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
  });

  it('still reads styles as source metadata when the output character quota is zero', async () => {
    const bytes = workbook(
      `<styleSheet xmlns="${MAIN}"><numFmts><numFmt numFmtId="164" formatCode="&quot;styled &quot;@"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>`,
      '<c r="A1" s="0" t="str"><v>value</v></c>',
    );
    const { ctx, out, budget, warnings } = context(bytes, { outputChars: 0 });
    await xlsxReader.read(ctx);
    expect(budget.outputChars).toBe(0);
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
    expect(
      warnings.warnings.some((warning) => warning.message === 'Spreadsheet styles could not be read.'),
    ).toBe(false);
    expect(out.finish().blocks).toHaveLength(0);
  });
});

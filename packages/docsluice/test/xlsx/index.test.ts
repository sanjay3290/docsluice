import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { extract } from '../../src/core/extract.js';
import type { Block, Cell, DocsluiceDocument } from '../../src/core/model.js';
import { formatGeneral } from '../../src/readers/xlsx/sheet.js';
import { columnName, parseCellReference, parseRangeReference } from '../../src/readers/xlsx/spreadsheetml.js';
import { xlsxReader } from '../../src/readers/xlsx/index.js';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

interface SheetSpec {
  name: string;
  xml: string;
  state?: string;
}

function workbook(sheets: SheetSpec[], sharedStrings?: string): Uint8Array {
  const files = Object.create(null) as Record<string, Uint8Array>;
  files['[Content_Types].xml'] = strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  files['_rels/.rels'] = strToU8(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  const entries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 1}"/>`,
    )
    .join('');
  files['xl/workbook.xml'] = strToU8(
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets>${entries}</sheets></workbook>`,
  );
  const relationships = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="${R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<Relationships xmlns="${PKG}">${relationships}<Relationship Id="rIdS" Type="${R}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  if (sharedStrings !== undefined) {
    files['xl/sharedStrings.xml'] = strToU8(`<sst xmlns="${S}">${sharedStrings}</sst>`);
  }
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheet.xml);
  });
  return zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
}

const worksheet = (rows: string, extra = '', before = '') =>
  `<worksheet xmlns="${S}">${before}<sheetData>${rows}</sheetData>${extra}</worksheet>`;

function sections(doc: DocsluiceDocument): Array<Extract<Block, { kind: 'section' }>> {
  return doc.blocks.filter((block) => block.kind === 'section');
}

function tables(block: Extract<Block, { kind: 'section' }>): Array<Extract<Block, { kind: 'table' }>> {
  return block.blocks.filter((child) => child.kind === 'table');
}

describe('XLSX reader', () => {
  it('is registered for XLSX packages', async () => {
    expect(xlsxReader.id).toBe('xlsx');
    const doc = await extract(
      workbook([{ name: 'One', xml: worksheet('<row r="1"><c r="A1"><v>1</v></c></row>') }]),
    );
    expect(doc.format).toBe('xlsx');
  });

  it('reads sheets in workbook order with names, hidden states, addresses and ranges', async () => {
    const doc = await extract(
      workbook(
        [
          {
            name: 'Second',
            xml: worksheet('<row r="2"><c r="B2" t="inlineStr"><is><t>b</t></is></c></row>'),
          },
          { name: 'Hidden', state: 'hidden', xml: worksheet('<row r="1"><c r="A1"><v>2</v></c></row>') },
          {
            name: 'Very',
            state: 'veryHidden',
            xml: worksheet('<row r="1"><c r="A1" t="b"><v>1</v></c></row>'),
          },
        ],
        '',
      ),
    );
    const [second, hidden, very] = sections(doc);
    expect(second).toMatchObject({ role: 'sheet', title: 'Second', loc: { sheet: 'Second' } });
    expect(second!.hidden).toBeUndefined();
    expect(hidden!.hidden).toBe(true);
    expect(very!.hidden).toBe('very');
    expect(tables(second!)[0]).toMatchObject({
      loc: { sheet: 'Second', range: 'B2:B2' },
      rows: [[{ text: 'b', address: 'B2' }]],
    });
    expect(tables(very!)[0]!.rows[0]).toEqual([{ text: 'TRUE', raw: true, address: 'A1' }]);
  });

  it('gives every grid cell its address, including empty and merged placeholders', async () => {
    const doc = await extract(
      workbook([
        {
          name: 'Grid',
          xml: worksheet(
            '<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c></row><row r="3"><c r="B3"><v>8</v></c></row>',
            '<mergeCells><mergeCell ref="A2:B2"/></mergeCells>',
          ),
        },
      ]),
    );
    const table = tables(sections(doc)[0]!)[0]!;
    expect(table.loc.range).toBe('A1:C3');
    const addresses = table.rows.map((row) => row.map((cell) => cell.address));
    expect(addresses).toEqual([
      ['A1', 'B1', 'C1'],
      ['A2', 'B2', 'C2'],
      ['A3', 'B3', 'C3'],
    ]);
    expect(table.rows[1]![0]).toEqual({ text: '', colSpan: 2, address: 'A2' });
    expect(table.rows[0]![0]).toEqual({ text: '1', raw: 1, address: 'A1' });
  });

  it('turns a sheet with values in A1 and Z90000 into two small tables quickly', async () => {
    const bytes = workbook([
      {
        name: 'Sparse',
        xml: worksheet(
          '<row r="1"><c r="A1" t="inlineStr"><is><t>top</t></is></c></row><row r="90000"><c r="Z90000" t="inlineStr"><is><t>bottom</t></is></c></row>',
          '',
          '<dimension ref="A1:Z90000"/>',
        ),
      },
    ]);
    const started = performance.now();
    const doc = await extract(bytes);
    const elapsed = performance.now() - started;
    const found = tables(sections(doc)[0]!);
    expect(found.map((table) => [table.loc.range, table.rows])).toEqual([
      ['A1:A1', [[{ text: 'top', address: 'A1' }]]],
      ['Z90000:Z90000', [[{ text: 'bottom', address: 'Z90000' }]]],
    ]);
    expect(elapsed).toBeLessThan(100);
  });

  it('keeps a small used range as one table even with empty rows between values', async () => {
    const doc = await extract(
      workbook([
        {
          name: 'Gaps',
          xml: worksheet('<row r="1"><c r="A1"><v>1</v></c></row><row r="5"><c r="B5"><v>2</v></c></row>'),
        },
      ]),
    );
    const found = tables(sections(doc)[0]!);
    expect(found).toHaveLength(1);
    expect(found[0]!.loc.range).toBe('A1:B5');
    expect(found[0]!.rows).toHaveLength(5);
  });

  it('stops a workbook claiming 1,048,576 x 16,384 cells at the cells limit with TRUNCATED', async () => {
    // A full first row and a long first column make the used range one dense-looking region.
    const columns: string[] = [];
    for (let column = 1; column <= 16_384; column++)
      columns.push(`<c r="${columnName(column)}1"><v>1</v></c>`);
    const rows = [`<row r="1">${columns.join('')}</row>`];
    for (let row = 2; row <= 2000; row++) rows.push(`<row r="${row}"><c r="A${row}"><v>${row}</v></c></row>`);
    rows.push('<row r="1048576"><c r="XFD1048576"><v>2</v></c></row>');
    const doc = await extract(
      workbook([
        { name: 'Huge', xml: worksheet(rows.join(''), '', '<dimension ref="A1:XFD1048576"/>') },
        { name: 'After', xml: worksheet('<row r="1"><c r="A1"><v>3</v></c></row>') },
      ]),
      { limits: { cells: 100_000 } },
    );
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings[0]!.code).toBe('TRUNCATED');
    expect(doc.warnings[0]!.message).toContain('"cells"');
    expect(doc.warnings[1]!.message).toBe(
      'Sheet 1: kept 5 rows and 81920 cells; skipped 1996 rows and 32686081 cells.',
    );
    const cells = sections(doc).flatMap((section) => tables(section).flatMap((table) => table.rows.flat()));
    expect(cells.length).toBeLessThanOrEqual(100_000);
    // The next sheet has nothing left to store; it is reported, not dropped silently.
    expect(doc.warnings[2]!.message).toBe('Sheet 2: kept 0 rows and 0 cells; skipped 1 rows and 1 cells.');
  });

  it('throws LIMIT_EXCEEDED at the cells limit when limits throw', async () => {
    const values = Array.from(
      { length: 50 },
      (_, index) => `<c r="${columnName(index + 1)}1"><v>1</v></c>`,
    ).join('');
    const bytes = workbook([{ name: 'Wide', xml: worksheet(`<row r="1">${values}</row>`) }]);
    await expect(extract(bytes, { limits: { cells: 10 }, onLimit: 'throw' })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('clips merges to the table holding their top-left cell and drops the rest', async () => {
    const doc = await extract(
      workbook([
        {
          name: 'Merges',
          xml: worksheet(
            '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>',
            '<mergeCells><mergeCell ref="A1:XFD1048576"/><mergeCell ref="D9:E9"/></mergeCells>',
            '<dimension ref="A1:XFD1048576"/>',
          ),
        },
      ]),
    );
    const table = tables(sections(doc)[0]!)[0]!;
    expect(table.loc.range).toBe('A1:B2');
    expect(table.rows).toEqual([
      [
        { text: '1', raw: 1, rowSpan: 2, colSpan: 2, address: 'A1' },
        { text: '', address: 'B1' },
      ],
      [
        { text: '', address: 'A2' },
        { text: '', address: 'B2' },
      ],
    ]);
  });

  it('caps the shared-string table at the cells limit with TRUNCATED', async () => {
    const doc = await extract(
      workbook(
        [
          {
            name: 'Few',
            xml: worksheet('<row r="1"><c r="A1" t="s"><v>4</v></c><c r="B1" t="s"><v>1</v></c></row>'),
          },
        ],
        '<si><t>a</t></si><si><t>b</t></si><si><t>c</t></si><si><t>d</t></si><si><t>e</t></si>',
      ),
      { limits: { cells: 3 } },
    );
    expect(tables(sections(doc)[0]!)[0]!.rows[0]!.map((cell) => cell.text)).toEqual(['', 'b']);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['TRUNCATED']);
  });

  it('counts value cells beyond the limit and reports them per sheet', async () => {
    const rows = Array.from(
      { length: 30 },
      (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index}</v></c></row>`,
    ).join('');
    const doc = await extract(workbook([{ name: 'Rows', xml: worksheet(rows) }]), { limits: { cells: 10 } });
    expect(doc.stats.truncated).toBe(true);
    const table = tables(sections(doc)[0]!)[0]!;
    expect(table.rows).toHaveLength(10);
    expect(doc.warnings.find((warning) => warning.message.startsWith('Sheet 1:'))?.message).toBe(
      'Sheet 1: kept 10 rows and 10 cells; skipped 20 rows and 20 cells.',
    );
  });

  it('resolves shared, rich and inline strings, skipping phonetic runs', async () => {
    const doc = await extract(
      workbook(
        [
          {
            name: 'Strings',
            xml: worksheet(
              '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><r><t>in</t></r><r><t>line</t></r></is></c></row>',
            ),
          },
        ],
        '<si><t>plain</t></si><si><r><t>ri</t></r><r><rPr><b/></rPr><t>ch</t></r><rPh><t>ignored</t></rPh></si>',
      ),
    );
    expect(tables(sections(doc)[0]!)[0]!.rows[0]!.map((cell) => cell.text)).toEqual([
      'plain',
      'rich',
      'inline',
    ]);
  });

  it('turns an out-of-range shared-string index into an empty cell and one UNREADABLE_PART', async () => {
    const doc = await extract(
      workbook(
        [
          {
            name: 'Bad',
            xml: worksheet(
              '<row r="1"><c r="A1" t="s"><v>7</v></c><c r="B1" t="s"><v>-1</v></c><c r="C1" t="s"><v>0</v></c></row>',
            ),
          },
        ],
        '<si><t>ok</t></si>',
      ),
    );
    expect(tables(sections(doc)[0]!)[0]!.rows[0]).toEqual([
      { text: '', address: 'A1' },
      { text: '', address: 'B1' },
      { text: 'ok', address: 'C1' },
    ]);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
    expect(doc.warnings[0]!.message).not.toContain('ok');
  });

  it('keeps booleans, errors, cached formula values and numbers with raw values', async () => {
    const doc = await extract(
      workbook([
        {
          name: 'Types',
          xml: worksheet(
            '<row r="1"><c r="A1" t="b"><v>0</v></c><c r="B1" t="e"><v>#N/A</v></c><c r="C1" t="str"><f>A</f><v>text</v></c><c r="D1"><f>1/3</f><v>0.33333333333333331</v></c><c r="E1"><v>0x10</v></c><c r="F1" s="3"/><c r="G1" t="d"><v>2026-01-02</v></c></row>',
          ),
        },
      ]),
    );
    expect(tables(sections(doc)[0]!)[0]!.rows[0]).toEqual([
      { text: 'FALSE', raw: false, address: 'A1' },
      { text: '#N/A', address: 'B1' },
      { text: 'text', address: 'C1' },
      { text: '0.333333333333333', raw: 0.3333333333333333, address: 'D1' },
      { text: '0x10', address: 'E1' },
      { text: '', address: 'F1' },
      { text: '2026-01-02', address: 'G1' },
    ]);
  });

  it('places rows and cells without references after the previous ones', async () => {
    const doc = await extract(
      workbook([
        {
          name: 'NoRefs',
          xml: worksheet(
            '<row><c><v>1</v></c><c><v>2</v></c></row><row><c r="C2"><v>3</v></c><c><v>4</v></c></row>',
          ),
        },
      ]),
    );
    const table = tables(sections(doc)[0]!)[0]!;
    expect(table.loc.range).toBe('A1:D2');
    expect(table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['1', '2', '', ''],
      ['', '', '3', '4'],
    ]);
  });

  it('keeps an unreadable sheet as an empty section with UNREADABLE_PART', async () => {
    const bytes = workbook([{ name: 'Ok', xml: worksheet('<row r="1"><c r="A1"><v>1</v></c></row>') }]);
    const files = Object.create(null) as Record<string, Uint8Array>;
    const { unzipSync } = await import('fflate');
    Object.assign(files, unzipSync(bytes));
    files['xl/workbook.xml'] = strToU8(
      `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Missing" sheetId="9" r:id="rId9"/><sheet name="Ok" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    );
    const doc = await extract(zipSync(files));
    const [missing, ok] = sections(doc);
    expect(missing).toMatchObject({ title: 'Missing', blocks: [] });
    expect(tables(ok!)).toHaveLength(1);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('ignores overlapping merges and keeps prototype-named sheets inert', async () => {
    const doc = await extract(
      workbook([
        {
          name: '__proto__',
          xml: worksheet(
            '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c></row>',
            '<mergeCells><mergeCell ref="A1:B2"/><mergeCell ref="B1:B2"/><mergeCell ref="A1"/><mergeCell ref="nonsense"/></mergeCells>',
          ),
        },
      ]),
    );
    const section = sections(doc)[0]!;
    expect(section.title).toBe('__proto__');
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    const rows = tables(section)[0]!.rows;
    expect(rows[0]![0]).toEqual({ text: '1', raw: 1, rowSpan: 2, colSpan: 2, address: 'A1' });
    expect(rows.flat().filter((cell: Cell) => cell.rowSpan || cell.colSpan)).toHaveLength(1);
  });

  it('reads a 50,000-row workbook within the PERF budget', async () => {
    const rows: string[] = [];
    for (let row = 1; row <= 50_000; row++) {
      rows.push(
        `<row r="${row}"><c r="A${row}" t="s"><v>${row % 100}</v></c><c r="B${row}"><v>${row * 1.5}</v></c><c r="C${row}" t="inlineStr"><is><t>note ${row}</t></is></c><c r="D${row}" t="b"><v>${row % 2}</v></c></row>`,
      );
    }
    const strings = Array.from({ length: 100 }, (_, index) => `<si><t>label ${index}</t></si>`).join('');
    const bytes = workbook([{ name: 'Big', xml: worksheet(rows.join('')) }], strings);
    const started = performance.now();
    const doc = await extract(bytes);
    const elapsed = performance.now() - started;
    const table = tables(sections(doc)[0]!)[0]!;
    expect(table.rows).toHaveLength(50_000);
    expect(table.rows[49_999]![2]).toEqual({ text: 'note 50000', address: 'C50000' });
    expect(doc.warnings).toEqual([]);
    // Target 3 s (about 2.0-2.3 s measured alone); the bound leaves room for loaded CI runners.
    expect(elapsed).toBeLessThan(6000);
  }, 20_000);

  it('never fetches and keeps external links as a feature only', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const doc = await extract(
      new Uint8Array(readFileSync(new URL('../../../../corpus/xlsx/cell-types.xlsx', import.meta.url))),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(sections(doc).map((section) => section.title)).toEqual(['Data', 'Hidden', 'VeryHidden']);
    vi.unstubAllGlobals();
  });
});

describe('SpreadsheetML references', () => {
  it('parses and names cells and ranges within the Excel grid', () => {
    expect(parseCellReference('B7')).toEqual({ row: 7, column: 2 });
    expect(parseCellReference('$xfd$1048576')).toEqual({ row: 1_048_576, column: 16_384 });
    expect(parseCellReference('XFE1')).toBeUndefined();
    expect(parseCellReference('A0')).toBeUndefined();
    expect(parseCellReference('A1048577')).toBeUndefined();
    expect(parseCellReference('A 1')).toBeUndefined();
    expect(parseRangeReference('C3:A1')).toEqual({ top: 1, left: 1, bottom: 3, right: 3 });
    expect(columnName(1)).toBe('A');
    expect(columnName(27)).toBe('AA');
    expect(columnName(16_384)).toBe('XFD');
  });

  it('formats numbers like the General format', () => {
    expect(formatGeneral(0.1 + 0.2)).toBe('0.3');
    expect(formatGeneral(-0)).toBe('0');
    expect(formatGeneral(1e21)).toBe('1E+21');
    expect(formatGeneral(1.5e-10)).toBe('1.5E-10');
    expect(formatGeneral(123456789012)).toBe('123456789012');
  });
});

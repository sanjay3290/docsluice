import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Block, Cell, DocsluiceDocument, TableBlock } from '../../src/core/model.js';
import { toRecords } from '../../src/render/records.js';
import { parseComments, parseThreadedComments } from '../../src/readers/xlsx/comments.js';
import { guessHeaderRows } from '../../src/readers/xlsx/header.js';
import { parseTablePart } from '../../src/readers/xlsx/tables.js';
import { parseSheetRange } from '../../src/readers/xlsx/workbook.js';
import { WarningSink } from '../../src/core/warnings.js';

const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../corpus/xlsx/${name}`, import.meta.url)));
const budget = () => new Budget(DEFAULT_LIMITS);
const context = () => ({ budget: budget(), warnings: new WarningSink() });
const encode = (text: string) => new TextEncoder().encode(text);

function sheetTables(doc: DocsluiceDocument, sheet = 0): TableBlock[] {
  const section = doc.blocks.filter((block) => block.kind === 'section')[sheet] as Extract<
    Block,
    { kind: 'section' }
  >;
  return section.blocks.filter((block): block is TableBlock => block.kind === 'table');
}

function sheetNotes(doc: DocsluiceDocument): Array<Extract<Block, { kind: 'note' }>> {
  const section = doc.blocks.find((block) => block.kind === 'section') as Extract<Block, { kind: 'section' }>;
  return section.blocks.filter((block): block is Extract<Block, { kind: 'note' }> => block.kind === 'note');
}

/** One sheet with `sheetXml`, optional sheet relationships and extra parts. */
function workbook(
  sheetXml: string,
  sheetRels = '',
  parts: Record<string, string> = {},
  names = '',
): Uint8Array {
  const files = Object.create(null) as Record<string, Uint8Array>;
  files['[Content_Types].xml'] = strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
  );
  files['_rels/.rels'] = strToU8(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="One" sheetId="1" r:id="rId1"/></sheets>${names}</workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  files['xl/worksheets/sheet1.xml'] = strToU8(sheetXml);
  if (sheetRels)
    files['xl/worksheets/_rels/sheet1.xml.rels'] = strToU8(
      `<Relationships xmlns="${PKG}">${sheetRels}</Relationships>`,
    );
  for (const [name, text] of Object.entries(parts)) files[name] = strToU8(text);
  return zipSync(files, { level: 6, mtime: new Date('1980-01-01T00:00:00Z') });
}

const cells = (...values: Array<string | number | boolean>): Cell[] =>
  values.map((value) => (typeof value === 'string' ? { text: value } : { text: String(value), raw: value }));

describe('header rows (XLS-8)', () => {
  it('guesses a text header over typed values and nothing else', () => {
    const typed = [cells('Item', 'Cost'), cells('Pump', 120)];
    expect(guessHeaderRows(typed, 'auto', budget())).toBe(1);
    expect(guessHeaderRows(typed, false, budget())).toBe(0);
    expect(guessHeaderRows([cells('a', 'b'), cells('c', 'd')], 'auto', budget())).toBe(0);
    expect(guessHeaderRows([cells('a', 2024), cells('b', 1)], 'auto', budget())).toBe(0);
    expect(guessHeaderRows([cells('Title', '', '', ''), cells(1, 2, 3, 4)], 'auto', budget())).toBe(0);
    expect(guessHeaderRows([cells('', ''), cells(1, 2)], 'auto', budget())).toBe(0);
    expect(guessHeaderRows([cells('only')], 'auto', budget())).toBe(0);
    expect(guessHeaderRows([cells('only')], true, budget())).toBe(1);
    expect(guessHeaderRows([], true, budget())).toBe(0);
    expect(guessHeaderRows([cells('Flag'), cells(true)], 'auto', budget())).toBe(1);
  });

  it('looks at the first 20 body rows only', () => {
    const rows = [cells('Name'), ...Array.from({ length: 20 }, () => cells('text')), cells(1)];
    expect(guessHeaderRows(rows, 'auto', budget())).toBe(0);
    rows.splice(20, 0, cells(2));
    expect(guessHeaderRows(rows, 'auto', budget())).toBe(1);
  });

  it('applies the headerRow option to the corpus workbook', async () => {
    const auto = await extract(corpus('header-detection.xlsx'));
    expect([0, 1, 2, 3].map((sheet) => sheetTables(auto, sheet)[0]!.headerRows)).toEqual([1, 0, 0, 0]);
    const forced = await extract(corpus('header-detection.xlsx'), { headerRow: true });
    expect([0, 1, 2, 3].map((sheet) => sheetTables(forced, sheet)[0]!.headerRows)).toEqual([1, 1, 1, 1]);
    const none = await extract(corpus('header-detection.xlsx'), { headerRow: false });
    expect([0, 1, 2, 3].map((sheet) => sheetTables(none, sheet)[0]!.headerRows)).toEqual([0, 0, 0, 0]);
  });

  it("uses an Excel table's header row count under auto, and the option when forced", async () => {
    const doc = await extract(corpus('tables-names.xlsx'));
    const byName = new Map(sheetTables(doc).map((table) => [table.caption, table.headerRows]));
    expect(byName.get('Sales')).toBe(1);
    expect(byName.get('Totals')).toBe(0);
    const forced = await extract(corpus('tables-names.xlsx'), { headerRow: false });
    expect(sheetTables(forced).every((table) => table.headerRows === 0)).toBe(true);
  });
});

describe('comments (XLS-9)', () => {
  it('emits notes after the tables with cell ranges, authors and part paths', async () => {
    const doc = await extract(corpus('comments.xlsx'));
    expect(sheetNotes(doc)).toEqual([
      {
        kind: 'note',
        role: 'comment',
        text: 'Should we split labour from parts?',
        author: 'Ada Reviewer',
        loc: expect.objectContaining({
          sheet: 'Budget',
          range: 'A1',
          path: 'xl/threadedComments/threadedComment1.xml',
        }) as unknown,
      },
      expect.objectContaining({ text: 'Yes, next quarter.', author: 'Grace Approver' }) as unknown,
      expect.objectContaining({
        text: 'Ada Reviewer:\nIncludes the spare seal.',
        author: 'Ada Reviewer',
        loc: expect.objectContaining({ range: 'B2', path: 'xl/comments1.xml' }) as unknown,
      }) as unknown,
      expect.objectContaining({
        text: 'Check the supplier.',
        loc: expect.objectContaining({ range: 'A3' }) as unknown,
      }) as unknown,
    ]);
  });

  it('drops comment authors with metadata: false', async () => {
    const doc = await extract(corpus('comments.xlsx'), { metadata: false });
    expect(sheetNotes(doc).map((note) => note.author)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('skips comments without a cell or text and ignores unknown authors', () => {
    const notes = parseComments(
      encode(
        `<comments xmlns="${S}"><authors><author>A</author></authors><commentList>` +
          '<comment authorId="0"><text><t>no ref</t></text></comment>' +
          '<comment ref="B2" authorId="7"><text><t>unknown author</t></text></comment>' +
          '<comment ref="C3" authorId="x"><text><t>  </t></text></comment>' +
          `<comment ref="D4" authorId="0"><text><t>${'x'.repeat(40_000)}</t></text></comment>` +
          '</commentList></comments>',
      ),
      context(),
    );
    expect(notes.map((note) => [note.ref, note.author, note.text.length])).toEqual([
      ['B2', undefined, 14],
      ['D4', 'A', 32_768],
    ]);
    const threaded = parseThreadedComments(
      encode(
        '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments">' +
          '<threadedComment personId="p"><text>no ref</text></threadedComment>' +
          '<threadedComment ref="A1" personId="missing"><text>kept</text></threadedComment></ThreadedComments>',
      ),
      context(),
      new Map([['__proto__', 'x']]),
    );
    expect(threaded).toEqual([{ ref: 'A1', text: 'kept' }]);
  });

  it('keeps a comment on an invalid cell reference without a range', async () => {
    const doc = await extract(
      workbook(
        `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>`,
        `<Relationship Id="c" Type="${R}/comments" Target="../comments1.xml"/>`,
        {
          'xl/comments1.xml': `<comments xmlns="${S}"><commentList><comment ref="ZZZZ0"><text><t>odd</t></text></comment></commentList></comments>`,
        },
      ),
    );
    const notes = sheetNotes(doc);
    expect(notes.map((note) => note.text)).toEqual(['odd']);
    expect(notes[0]!.loc.range).toBeUndefined();
  });
});

describe('Excel tables and defined names (XLS-9)', () => {
  it('names matching regions and adds the other ranges as tables', async () => {
    const doc = await extract(corpus('tables-names.xlsx'));
    expect(sheetTables(doc).map((table) => [table.caption, table.loc.range])).toEqual([
      [undefined, 'A1:G8'],
      ['Sales', 'A1:C4'],
      ['Totals', 'A7:C8'],
      ['Rates', 'F1:G3'],
      ['TopTwo', 'A2:C3'],
    ]);
    expect(sheetTables(doc, 1).map((table) => [table.caption, table.loc.range])).toEqual([['Odd', 'A1:B2']]);
  });

  it('parses one-range defined names only', () => {
    expect(parseSheetRange('Data!$A$1:$C$4', budget())).toEqual({
      sheet: 'Data',
      range: { top: 1, left: 1, bottom: 4, right: 3 },
    });
    expect(parseSheetRange(" 'It''s'!B2 ", budget())).toEqual({
      sheet: "It's",
      range: { top: 2, left: 2, bottom: 2, right: 2 },
    });
    for (const formula of [
      '0.2',
      '#REF!$A$1',
      'Data!A1,Data!B2',
      "'open!A1",
      "'x'A1",
      '!A1',
      'Data!A:A',
      "''!A1",
    ])
      expect(parseSheetRange(formula, budget()), formula).toBeUndefined();
  });

  it('reads an Excel table part and ignores parts that are not one', () => {
    const table = (attrs: string) => encode(`<table xmlns="${S}" ${attrs}/>`);
    expect(parseTablePart(table('name="T" ref="B2:C3"'), context())).toEqual({
      name: 'T',
      range: { top: 2, left: 2, bottom: 3, right: 3 },
      headerRows: 1,
    });
    expect(
      parseTablePart(table('name="T" displayName="Shown" ref="A1" headerRowCount="0"'), context()),
    ).toMatchObject({
      name: 'Shown',
      headerRows: 0,
    });
    expect(parseTablePart(table('ref="A1"'), context())).toBeUndefined();
    expect(parseTablePart(table('name="T" ref="nowhere"'), context())).toBeUndefined();
    expect(parseTablePart(encode('<other name="T" ref="A1"/>'), context())).toBeUndefined();
  });

  it('charges extra tables to the cells budget', async () => {
    const names = Array.from(
      { length: 50 },
      (_, index) => `<definedName name="N${index}">One!$A$1:$B$2</definedName>`,
    ).join('');
    const doc = await extract(
      workbook(
        `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row><row r="2"><c r="A2"><v>3</v></c><c r="B2"><v>4</v></c></row><row r="3"><c r="C3"><v>5</v></c></row></sheetData></worksheet>`,
        '',
        {},
        `<definedNames>${names}</definedNames>`,
      ),
      { limits: { cells: 40 } },
    );
    const tables = sheetTables(doc);
    expect(tables.length).toBeLessThan(12);
    expect(doc.stats.truncated).toBe(true);
  });
});

describe('hidden rows and columns (XLS-10)', () => {
  it('keeps hidden rows and columns and flags their cells', async () => {
    const doc = await extract(corpus('hidden-rows-columns.xlsx'));
    const [table] = sheetTables(doc);
    const flags = table!.rows.map((row) => row.map((cell) => (cell.hidden ? 'H' : '.')).join(''));
    expect(flags).toEqual(['.H.HH', '.H.HH', 'HHHHH', '.H.HH']);
    expect(table!.rows[2]![0]!.text).toBe('Old pump');
  });

  it('ignores hidden column entries that are out of range', async () => {
    const doc = await extract(
      workbook(
        `<worksheet xmlns="${S}"><cols><col min="0" max="1" hidden="1"/><col min="3" max="2" hidden="1"/><col min="2" max="99999" hidden="1"/><col min="1" max="1" hidden="0"/></cols><sheetData><row r="1" hidden="true"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>3</v></c></row></sheetData></worksheet>`,
      ),
    );
    expect(sheetTables(doc)[0]!.rows.map((row) => row.map((cell) => cell.hidden === true))).toEqual([
      [true, true],
      [false, false],
    ]);
  });
});

describe('toRecords (REN-5)', () => {
  const table = (rows: Cell[][], headerRows = 1): TableBlock => ({
    kind: 'table',
    rows,
    headerRows,
    loc: {},
  });

  it('keys rows by the header row, with null-prototype records', () => {
    const records = toRecords(table([cells('Item', 'Cost'), cells('Pump', 120), cells('Valve')]));
    expect(records.map((record) => ({ ...record }))).toEqual([
      { Item: 'Pump', Cost: '120' },
      { Item: 'Valve', Cost: '' },
    ]);
    expect(Object.getPrototypeOf(records[0])).toBeNull();
  });

  it('keeps __proto__ and other dangerous headers as ordinary keys', () => {
    const [record] = toRecords(table([cells('__proto__', 'constructor', 'toString'), cells('a', 'b', 'c')]));
    expect(Object.keys(record!)).toEqual(['__proto__', 'constructor', 'toString']);
    expect(Object.getOwnPropertyDescriptor(record, '__proto__')?.value).toBe('a');
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.prototype).not.toHaveProperty('a');
  });

  it('de-duplicates names and names empty and merged header cells', () => {
    const header: Cell[] = [
      { text: 'name' },
      { text: 'name' },
      { text: 'name_2' },
      { text: '' },
      { text: 'Q1', colSpan: 2 },
      { text: '' },
      { text: ' ' },
    ];
    const [record] = toRecords(table([header, cells('1', '2', '3', '4', '5', '6', '7', '8')]));
    expect(Object.keys(record!)).toEqual([
      'name',
      'name_2',
      'name_2_2',
      'column4',
      'Q1',
      'Q1_2',
      'column7',
      'column8',
    ]);
  });

  it('uses positions without a header and the last of several header rows', () => {
    expect(toRecords(table([cells('a', 'b')], 0)).map((record) => ({ ...record }))).toEqual([
      { column1: 'a', column2: 'b' },
    ]);
    expect(
      toRecords(table([cells('Group', ''), cells('x', 'y'), cells('1', '2')], 2)).map((record) => ({
        ...record,
      })),
    ).toEqual([{ x: '1', y: '2' }]);
    expect(toRecords(table([cells('a')], 5))).toEqual([]);
    expect(toRecords(table([], 1))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { EncryptedError, LimitExceededError } from '../../../src/core/errors.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Block, Cell, DocsluiceDocument } from '../../../src/core/model.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { MAX_REPEATED_COPIES, odsFormula, parseOdsContent } from '../../../src/readers/ods/content.js';
import { fuzzOds } from '../../../fuzz/ods.fuzz.js';
import { makeZip } from '../../helpers/zip.js';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};
const encode = (text: string) => new TextEncoder().encode(text);

function contentXml(body: string, styles = ''): string {
  return (
    `<office:document-content xmlns:office="${NS.office}" xmlns:table="${NS.table}" xmlns:text="${NS.text}" ` +
    `xmlns:style="${NS.style}" xmlns:xlink="${NS.xlink}"><office:automatic-styles>${styles}</office:automatic-styles>` +
    `<office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`
  );
}

function ods(
  body: string,
  options: { styles?: string; extra?: Array<{ name: string; data: Uint8Array }> } = {},
) {
  return makeZip([
    { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.spreadsheet'), method: 0 },
    { name: 'content.xml', data: encode(contentXml(body, options.styles)) },
    ...(options.extra ?? []),
  ]);
}

const table = (rows: string, attrs = 'table:name="Sheet1"') => `<table:table ${attrs}>${rows}</table:table>`;
const row = (cells: string, attrs = '') => `<table:table-row ${attrs}>${cells}</table:table-row>`;
const text = (value: string, attrs = 'office:value-type="string"') =>
  `<table:table-cell ${attrs}><text:p>${value}</text:p></table:table-cell>`;

function tables(doc: DocsluiceDocument): Cell[][][] {
  return doc.blocks.flatMap((section: Block) =>
    section.kind === 'section'
      ? section.blocks.flatMap((block) => (block.kind === 'table' ? [block.rows] : []))
      : [],
  );
}

function texts(doc: DocsluiceDocument): string[][][] {
  return tables(doc).map((rows) => rows.map((cells) => cells.map((cell) => cell.text)));
}

const parse = (body: string, limits: Partial<typeof DEFAULT_LIMITS> = {}) => {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  return { content: parseOdsContent(encode(contentXml(body)), { budget, warnings }), budget };
};

describe('ODS reader', () => {
  it('reads sheets as sections of tables with addresses, values and raw values', async () => {
    const doc = await extract(
      ods(
        table(
          row(text('Name') + text('Count') + text('Share') + text('Price') + text('Seen') + text('Done')) +
            row(
              text('Heron') +
                text('4', 'office:value-type="float" office:value="4"') +
                text('25%', 'office:value-type="percentage" office:value="0.25"') +
                text('€1.50', 'office:value-type="currency" office:currency="EUR" office:value="1.5"') +
                text('03/14/2025', 'office:value-type="date" office:date-value="2025-03-14"') +
                text('TRUE', 'office:value-type="boolean" office:boolean-value="true"'),
            ),
          'table:name="Counts"',
        ) + table(row(text('second')), 'table:name="Other"'),
      ),
      { filename: 'counts.ods' },
    );
    expect(doc.format).toBe('ods');
    const [first, second] = doc.blocks;
    expect(first).toMatchObject({
      kind: 'section',
      role: 'sheet',
      title: 'Counts',
      loc: { sheet: 'Counts' },
    });
    expect(second).toMatchObject({ kind: 'section', title: 'Other' });
    const cells = tables(doc)[0]![1]!;
    expect(cells.map((cell) => [cell.text, cell.raw, cell.address])).toEqual([
      ['Heron', undefined, 'A2'],
      ['4', 4, 'B2'],
      ['25%', 0.25, 'C2'],
      ['€1.50', 1.5, 'D2'],
      ['03/14/2025', '2025-03-14', 'E2'],
      ['TRUE', true, 'F2'],
    ]);
  });

  it('does not allocate for a row repeated 1,048,576 times with one empty cell', () => {
    const { content, budget } = parse(
      table(
        row(text('top')) +
          row(
            '<table:table-cell table:number-columns-repeated="16384"/>',
            'table:number-rows-repeated="1048576"',
          ),
      ),
    );
    const sheet = content.sheets[0]!.sheet;
    expect(sheet.rows.size).toBe(1);
    expect(sheet.stored).toBe(1);
    expect(budget.cells).toBe(1);
  });

  it('expands repeated value cells up to the copy cap and counts the rest', async () => {
    const started = performance.now();
    const doc = await extract(
      ods(
        table(
          row(
            '<table:table-cell office:value-type="float" office:value="7" table:number-columns-repeated="3"><text:p>7</text:p></table:table-cell>',
            'table:number-rows-repeated="1048576"',
          ),
        ),
      ),
    );
    expect(performance.now() - started).toBeLessThan(10_000);
    // The last, partly kept row is padded with empty cells in its table grid; count values only.
    const stored = tables(doc)
      .flat(2)
      .filter((cell) => cell.text === '7').length;
    expect(stored).toBe(MAX_REPEATED_COPIES + 1);
    // The skipped copies are charged to `cells`: the file claims more than the limit allows.
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['TRUNCATED', 'TRUNCATED']);
    expect(doc.warnings[0]!.message).toContain('"cells"');
    expect(doc.warnings[1]!.message).toContain(`skipped 1026730 rows`);
  });

  it('expands small repeats and stops at the cells limit without visiting the rest', async () => {
    const repeated = row(
      '<table:table-cell office:value-type="string" table:number-columns-repeated="2"><text:p>x</text:p></table:table-cell>',
      'table:number-rows-repeated="3"',
    );
    expect(texts(await extract(ods(table(repeated))))).toEqual([
      [
        ['x', 'x'],
        ['x', 'x'],
        ['x', 'x'],
      ],
    ]);
    const { content } = parse(table(repeated), { cells: 3 });
    expect(content.sheets[0]!.sheet).toMatchObject({ stored: 3, skippedCells: 3, skippedRows: 1 });
    await expect(
      extract(ods(table(repeated)), { limits: { cells: 3 }, onLimit: 'throw' }),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('keeps sparse cells apart and ignores content past the last column', async () => {
    const doc = await extract(
      ods(
        table(
          row(text('A1')) +
            row('<table:table-cell/>', 'table:number-rows-repeated="89998"') +
            row('<table:table-cell table:number-columns-repeated="25"/>' + text('Z90000')) +
            row('<table:table-cell table:number-columns-repeated="16384"/>' + text('beyond')),
        ),
      ),
    );
    expect(tables(doc).map((rows) => rows.map((cells) => cells.map((cell) => cell.address)))).toEqual([
      [['A1']],
      [['Z90000']],
    ]);
  });

  it('reads merged and covered cells like XLSX', async () => {
    const doc = await extract(
      ods(
        table(
          row(
            '<table:table-cell table:number-columns-spanned="2" table:number-rows-spanned="2" office:value-type="string"><text:p>Merged</text:p></table:table-cell><table:covered-table-cell><text:p>hidden copy</text:p></table:covered-table-cell>' +
              text('C1'),
          ) + row('<table:covered-table-cell table:number-columns-repeated="2"/>' + text('C2')),
        ),
      ),
    );
    const rows = tables(doc)[0]!;
    expect(rows[0]!.map((cell) => [cell.text, cell.colSpan, cell.rowSpan])).toEqual([
      ['Merged', 2, 2],
      ['', undefined, undefined],
      ['C1', undefined, undefined],
    ]);
  });

  it('builds displayed text from paragraphs, spaces, tabs and breaks, without annotations or nested tables', async () => {
    const doc = await extract(
      ods(
        table(
          row(
            '<table:table-cell office:value-type="string"><office:annotation><text:p>note</text:p></office:annotation>' +
              '<text:p>a<text:s text:c="3"/>b<text:tab/>c<text:line-break/>d <text:span>e</text:span></text:p><text:p>second</text:p>' +
              `<table:table><table:table-row>${text('inner')}</table:table-row></table:table></table:table-cell>` +
              text('<text:a xlink:href="https://example.org/x">link</text:a>'),
          ),
        ),
      ),
    );
    expect(texts(doc)).toEqual([[['a   b\tc\nd e\nsecond', 'link']]]);
    expect(doc.features.hasExternalLinks).toBe(true);
  });

  it('falls back to typed values without paragraphs and leaves formulas without a value empty', async () => {
    const doc = await extract(
      ods(
        table(
          row(
            '<table:table-cell office:value-type="float" office:value="1.5"/>' +
              '<table:table-cell office:value-type="boolean" office:boolean-value="false"/>' +
              '<table:table-cell office:value-type="time" office:time-value="PT01H30M00S"/>' +
              '<table:table-cell office:value-type="string" office:string-value="sv"/>' +
              '<table:table-cell table:formula="of:=[.A1]*2"/>' +
              '<table:table-cell office:value-type="float" office:value="not a number"><text:p>shown</text:p></table:table-cell>',
          ),
        ),
      ),
      { formulas: true },
    );
    expect(tables(doc)[0]![0]!.map((cell) => [cell.text, cell.raw, cell.formula])).toEqual([
      ['1.5', 1.5, undefined],
      ['FALSE', false, undefined],
      ['PT01H30M00S', undefined, undefined],
      ['sv', undefined, undefined],
      ['', undefined, '=A1*2'],
      ['shown', undefined, undefined],
    ]);
    expect(doc.warnings.map((warning) => warning.message)).toEqual([
      'Sheet 1: 1 formula cells have no cached value and are empty; formulas are never calculated.',
    ]);
  });

  it('converts OpenFormula references to A1 formulas', () => {
    const ctx = { budget: new Budget(DEFAULT_LIMITS), warnings: new WarningSink() };
    expect(odsFormula('of:=SUM([.A1:.B2])', ctx)).toBe('=SUM(A1:B2)');
    expect(odsFormula('of:=[$Other.A1]+[$Other.$B$2:.C3]', ctx)).toBe('=Other!A1+Other!$B$2:C3');
    expect(odsFormula('of:=[\'My sheet\'.A1]&"[.x]"', ctx)).toBe('=\'My sheet\'!A1&"[.x]"');
    expect(odsFormula('=1+1', ctx)).toBe('=1+1');
  });

  it('marks hidden sheets from table:display and from table styles', async () => {
    const doc = await extract(
      ods(
        table(row(text('a')), 'table:name="Shown" table:style-name="ta1"') +
          table(row(text('b')), 'table:name="ByStyle" table:style-name="ta2"') +
          table(row(text('c')), 'table:name="ByAttribute" table:display="false"'),
        {
          styles:
            '<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true"/></style:style>' +
            '<style:style style:name="ta2" style:family="table"><style:table-properties table:display="false"/></style:style>',
        },
      ),
    );
    expect(doc.blocks.map((block) => (block.kind === 'section' ? [block.title, block.hidden] : []))).toEqual([
      ['Shown', undefined],
      ['ByStyle', true],
      ['ByAttribute', true],
    ]);
  });

  it('resolves attributes by namespace, not by prefix', async () => {
    const content =
      `<o:document-content xmlns:o="${NS.office}" xmlns:t="${NS.table}" xmlns:x="${NS.text}"><o:body><o:spreadsheet>` +
      `<t:table t:name="Prefixed"><t:table-row t:number-rows-repeated="2"><t:table-cell o:value-type="float" o:value="3"><x:p>3</x:p></t:table-cell></t:table-row></t:table>` +
      '</o:spreadsheet></o:body></o:document-content>';
    const doc = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.spreadsheet'), method: 0 },
        { name: 'content.xml', data: encode(content) },
      ]),
    );
    expect(tables(doc)[0]!.map((cells) => cells.map((cell) => [cell.text, cell.raw, cell.address]))).toEqual([
      [['3', 3, 'A1']],
      [['3', 3, 'A2']],
    ]);
  });

  it('flags macros and embedded objects, reads metadata and refuses encrypted packages', async () => {
    const meta =
      `<office:document-meta xmlns:office="${NS.office}" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      '<office:meta><dc:title>Survey</dc:title></office:meta></office:document-meta>';
    const doc = await extract(
      ods(table(row(text('x'))), {
        extra: [
          { name: 'meta.xml', data: encode(meta) },
          { name: 'Basic/Standard/Module1.xml', data: encode('<module/>') },
          { name: 'Object 1/content.xml', data: encode('<x/>') },
        ],
      }),
    );
    expect(doc.metadata.title).toBe('Survey');
    expect(doc.features).toMatchObject({ hasMacros: true, hasEmbeddedFiles: true });
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['MACROS_PRESENT']);

    const manifest =
      `<manifest:manifest xmlns:manifest="${NS.manifest}"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">` +
      '<manifest:encryption-data/></manifest:file-entry></manifest:manifest>';
    await expect(
      extract(
        ods(table(row(text('x'))), { extra: [{ name: 'META-INF/manifest.xml', data: encode(manifest) }] }),
      ),
    ).rejects.toBeInstanceOf(EncryptedError);
  });

  it('warns about a missing content part and duplicate part names', async () => {
    const missing = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.spreadsheet'), method: 0 },
      ]),
    );
    expect(missing.blocks).toEqual([]);
    expect(missing.warnings.map((warning) => warning.message)).toEqual([
      'The ODS package has no content part.',
    ]);
    const duplicate = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.spreadsheet'), method: 0 },
        { name: 'content.xml', data: encode(contentXml(table(row(text('a'))))) },
        { name: 'content.xml', data: encode(contentXml(table(row(text('b'))))) },
      ]),
    );
    expect(duplicate.blocks).toEqual([]);
    expect(duplicate.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
  });

  it('survives the fuzz target on packages and raw content', async () => {
    await expect(fuzzOds(ods(table(row(text('a')))))).resolves.toBeUndefined();
    await expect(fuzzOds(encode(contentXml(table(row(text('a'))))))).resolves.toBeUndefined();
    await expect(fuzzOds(encode('<not xml'))).resolves.toBeUndefined();
  });
});

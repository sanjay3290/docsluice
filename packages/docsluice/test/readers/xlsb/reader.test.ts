import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import {
  AbortError,
  CorruptFileError,
  LimitExceededError,
  StrictModeError,
} from '../../../src/core/errors.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { Limits } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { openZip } from '../../../src/zip/index.js';
import { parseXlsb, xlsbReader } from '../../../src/readers/xlsb/index.js';
import { fuzzXlsb } from '../../../fuzz/xlsb.fuzz.js';

const DEFAULT_OPTIONS = {
  filename: 'fixture.xlsb',
  limits: resolveLimits(),
  onLimit: 'truncate',
  strict: false,
  metadata: true,
  children: 'skip',
  childBytes: false,
  runs: false,
  revisions: 'accept',
  includeHidden: true,
  formulas: false,
} as ResolvedOptions;

type TestOptions = Omit<Partial<ResolvedOptions>, 'limits'> & { limits?: Partial<Limits> };

function createContext(bytes: Uint8Array, options: TestOptions = {}) {
  const warnings = new WarningSink({ strict: options.strict });
  const budget = new Budget(resolveLimits(options.limits), {
    warnings,
    signal: options.signal,
    onLimit: options.onLimit,
  });
  const builder = new DocBuilder('xlsb', xlsbReader.mimeTypes[0]!, budget, {
    formulas: options.formulas ?? false,
  });
  const context: ReadContext = {
    bytes,
    filename: 'fixture.xlsb',
    options: { ...DEFAULT_OPTIONS, ...options, limits: resolveLimits(options.limits) },
    budget,
    warnings: budget.warnings,
    out: builder,
    path: '',
    async extractChild() {},
    zip: openZip(bytes, budget),
  };
  return { context, builder, budget };
}

describe('XLSB reader', () => {
  it('advertises the whole-workbook XLSB MIME type', () => {
    expect(xlsbReader.mimeTypes).toEqual(['application/vnd.ms-excel.sheet.binary.macroEnabled.12']);
  });

  it('reads workbook order and cached scalar values from an authored XLSB package', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-edgecases.xlsb', import.meta.url)));
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(doc.blocks).toMatchObject([
      {
        kind: 'section',
        role: 'sheet',
        title: 'Main',
        blocks: [
          {
            kind: 'table',
            loc: { range: 'A1:C1' },
            rows: [
              [
                { address: 'A1', raw: 'Alpha', text: 'Alpha' },
                { address: 'B1', raw: 1234.5, text: '1,234.50' },
                { address: 'C1', raw: 42.5, text: '42.5' },
              ],
            ],
          },
          { kind: 'table', loc: { range: 'B2' }, rows: [[{ address: 'B2', text: 'TRUE', hidden: true }]] },
          {
            kind: 'table',
            loc: { range: 'A3:C3' },
            rows: [
              [
                { address: 'A3', raw: 1.23, text: '1.23' },
                { address: 'B3', raw: 'inline', text: 'inline' },
                { address: 'C3', raw: '#N/A', text: '#N/A' },
              ],
            ],
          },
          { kind: 'table', loc: { range: 'D4' }, rows: [[{ address: 'D4', text: 'secret', hidden: true }]] },
          {
            kind: 'table',
            loc: { range: 'E5' },
            rows: [[{ address: 'E5', raw: 'merged', text: 'merged', colSpan: 2 }]],
          },
          {
            kind: 'table',
            loc: { range: 'A6:B7' },
            rows: [
              [
                { address: 'A6', text: 'top' },
                { address: 'B6', text: '2' },
              ],
              [
                { address: 'A7', text: 'bottom' },
                { address: 'B7', text: '3' },
              ],
            ],
          },
          { kind: 'table', loc: { range: 'Z90000' }, rows: [[{ address: 'Z90000', text: 'far' }]] },
        ],
      },
      { kind: 'section', role: 'sheet', title: 'Hidden', hidden: true },
      { kind: 'section', role: 'sheet', title: 'Very', hidden: 'very' },
    ]);
    expect(doc.warnings.map(({ code }) => code)).toContain('HIDDEN_CONTENT');
    const { context: parsedContext } = createContext(bytes);
    const parsed = await parseXlsb(parsedContext);
    expect(parsed.sheets.map(({ name, state }) => [name, state])).toEqual([
      ['Main', 'visible'],
      ['Hidden', 'hidden'],
      ['Very', 'very'],
    ]);
  });

  it('applies the workbook 1904 date system and retains cached formula strings without evaluation', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-1904.xlsb', import.meta.url)));
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    expect(builder.finish().blocks).toMatchObject([
      {
        kind: 'section',
        title: 'Main',
        blocks: [
          {
            kind: 'table',
            rows: [
              [
                { address: 'A1', raw: 0, text: '1904-01-01' },
                { address: 'B1', raw: 'cached', text: 'cached' },
              ],
            ],
          },
        ],
      },
      { kind: 'section', title: 'Hidden' },
      { kind: 'section', title: 'Very' },
    ]);
  });

  it('warns when formula text is requested because token rendering is not part of this adapter', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-edgecases.xlsb', import.meta.url)));
    const { context, builder } = createContext(bytes, { formulas: true });
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(doc.warnings).toContainEqual(
      expect.objectContaining({
        code: 'UNREADABLE_PART',
        message: 'Formula text is not supported by this XLSB reader.',
      }),
    );
    expect(JSON.stringify(doc)).not.toContain('SUM(');
  });

  it('skips an invalid shared-string reference with a content-free warning', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-bad-shared-index.xlsb', import.meta.url)),
    );
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(JSON.stringify(doc)).not.toContain('Alpha');
    expect(doc.warnings).toContainEqual(
      expect.objectContaining({
        code: 'UNREADABLE_PART',
        message: 'A shared string index could not be resolved.',
      }),
    );
  });

  it('retains explicit blank cells between values and on a blank-only row', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-blanks.xlsb', import.meta.url)));
    const { context, builder, budget } = createContext(bytes);
    await xlsbReader.read(context);
    expect(builder.finish().blocks[0]).toMatchObject({
      kind: 'section',
      title: 'Main',
      blocks: [
        {
          kind: 'table',
          loc: { range: 'A1:C1' },
          rows: [
            [
              { address: 'A1', text: 'left' },
              { address: 'B1', raw: null, text: '' },
              { address: 'C1', text: 'right' },
            ],
          ],
        },
        { kind: 'table', loc: { range: 'D3' }, rows: [[{ address: 'D3', raw: null, text: '' }]] },
      ],
    });
    expect(budget.cells).toBe(4);
  });

  it('preflights rejected output text before charging retained-cell quota', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-retention-order.xlsb', import.meta.url)),
    );
    const { context, builder, budget } = createContext(bytes, {
      limits: { cells: 1, outputChars: 100 },
    });
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(doc.blocks).toMatchObject([
      { kind: 'section', title: 'A', blocks: [] },
      {
        kind: 'section',
        title: 'B',
        blocks: [{ kind: 'table', rows: [[{ address: 'A1', text: 'ok' }]] }],
      },
      { kind: 'section', title: 'C' },
    ]);
    expect(budget.cells).toBe(1);
    expect(doc.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('honors cell and output limits in truncate and throw modes', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-edgecases.xlsb', import.meta.url)));
    const { context, builder } = createContext(bytes, { limits: { cells: 1 } });
    await xlsbReader.read(context);
    expect(builder.finish().blocks[0]).toMatchObject({
      kind: 'section',
      title: 'Main',
      blocks: [{ kind: 'table', rows: [[{ address: 'A1' }]] }],
    });

    const { context: cellThrow } = createContext(bytes, { limits: { cells: 1 }, onLimit: 'throw' });
    await expect(xlsbReader.read(cellThrow)).rejects.toMatchObject({
      name: 'LimitExceededError',
      limit: 'cells',
    });

    const retention = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-retention-order.xlsb', import.meta.url)),
    );
    const { context: outputThrow } = createContext(retention, {
      limits: { cells: 1, outputChars: 100 },
      onLimit: 'throw',
    });
    await expect(xlsbReader.read(outputThrow)).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('promotes parser warnings under strict mode and rejects malformed worksheet data', async () => {
    const invalidStrings = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-bad-shared-index.xlsb', import.meta.url)),
    );
    const { context: strictContext } = createContext(invalidStrings, { strict: ['UNREADABLE_PART'] });
    await expect(xlsbReader.read(strictContext)).rejects.toBeInstanceOf(StrictModeError);

    const malformed = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-malformed-worksheet.xlsb', import.meta.url)),
    );
    const { context } = createContext(malformed);
    await expect(xlsbReader.read(context)).rejects.toBeInstanceOf(CorruptFileError);
  });

  it('keeps valid cells around malformed worksheet descriptors and reports duplicates once', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-warning-paths.xlsb', import.meta.url)),
    );
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(doc.blocks[0]).toMatchObject({
      kind: 'section',
      title: 'Main',
      blocks: [{ kind: 'table', loc: { range: 'A1' }, rows: [[{ address: 'A1', text: 'kept' }]] }],
    });
    const messages = doc.warnings.map(({ message }) => message);
    expect(messages).toContain('A worksheet column descriptor was invalid.');
    expect(messages).toContain('A worksheet merge range was invalid.');
    expect(messages).toContain('A worksheet contained duplicate cell addresses.');
    expect(messages).toContain('The XLSB worksheet contained unreadable cell data.');
  });

  it('falls back to General for malformed styles and invalid style indexes', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-malformed-styles.xlsb', import.meta.url)),
    );
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    const doc = builder.finish();
    const section = doc.blocks[0];
    expect(section?.kind).toBe('section');
    if (section?.kind !== 'section') throw new Error('Expected a sheet section.');
    const table = section.blocks.find((block) => block.kind === 'table');
    expect(table?.kind).toBe('table');
    if (table?.kind !== 'table') throw new Error('Expected a table block.');
    expect(table.rows.flat().find((cell) => cell.address === 'B1')).toMatchObject({
      address: 'B1',
      raw: 1234.5,
      text: '1234.5',
    });
    expect(doc.warnings.map(({ message }) => message)).toContain(
      'The XLSB styles part contained unsupported or malformed records.',
    );
    expect(doc.warnings.map(({ message }) => message)).toContain('A cell style index could not be resolved.');
  });

  it('rejects non-finite floating RK values while preserving legal integer RK cells', async () => {
    const valid = new Uint8Array(readFileSync(new URL('./fixtures/reader-edgecases.xlsb', import.meta.url)));
    const { context: validContext, builder: validBuilder } = createContext(valid);
    await xlsbReader.read(validContext);
    const main = validBuilder.finish().blocks[0];
    expect(main?.kind).toBe('section');
    if (main?.kind === 'section') {
      const tables = main.blocks.filter((block) => block.kind === 'table');
      expect(tables[2]?.kind).toBe('table');
      if (tables[2]?.kind === 'table') {
        expect(tables[2].rows[0]?.[0]).toMatchObject({ address: 'A3', raw: 1.23, text: '1.23' });
      }
    }

    const invalid = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-invalid-rk.xlsb', import.meta.url)),
    );
    const { context: invalidContext } = createContext(invalid);
    await expect(xlsbReader.read(invalidContext)).rejects.toBeInstanceOf(CorruptFileError);
  });

  it('skips unresolved and non-worksheet links and rejects invalid or duplicate sheet descriptors', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-link-warnings.xlsb', import.meta.url)),
    );
    const { context, builder } = createContext(bytes);
    await xlsbReader.read(context);
    const doc = builder.finish();
    expect(doc.blocks[0]).toMatchObject({ kind: 'section', title: 'Main' });
    const messages = doc.warnings.map(({ message }) => message);
    expect(messages).toContain('The workbook contains an invalid sheet descriptor.');
    expect(messages).toContain('The workbook contains duplicate sheet identifiers.');
    expect(messages).toContain('A workbook sheet relationship could not be resolved.');
    expect(messages).toContain('A workbook sheet relationship is not a worksheet part.');
  });

  it('propagates cancellation and rejects a malformed workbook record stream', async () => {
    const controller = new AbortController();
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/reader-edgecases.xlsb', import.meta.url)));
    const { context: canceled } = createContext(bytes, { signal: controller.signal });
    controller.abort();
    await expect(xlsbReader.read(canceled)).rejects.toBeInstanceOf(AbortError);

    const malformed = new Uint8Array(
      readFileSync(new URL('./fixtures/reader-malformed.xlsb', import.meta.url)),
    );
    const { context, builder } = createContext(malformed);
    await expect(xlsbReader.read(context)).rejects.toBeInstanceOf(CorruptFileError);
    builder.finish();
  });

  it('runs malformed and authored packages through the bounded XLSB reader fuzz target', async () => {
    const malformed = [
      new Uint8Array(),
      new Uint8Array([0, 0, 0, 0]),
      new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xff]),
      Uint8Array.from({ length: 4_096 }, (_, index) => (index * 53 + 17) & 0xff),
    ];
    for (const bytes of malformed) await expect(fuzzXlsb(bytes)).resolves.toBeUndefined();

    const authored = new Uint8Array(
      readFileSync(new URL('./fixtures/corpus/edgecases.xlsb', import.meta.url)),
    );
    const expected = JSON.parse(
      readFileSync(new URL('./fixtures/corpus/edgecases.expected.json', import.meta.url), 'utf8'),
    ) as {
      sheets: Array<{
        name: string;
        state: string;
        ranges: string[];
        addresses: string[][];
      }>;
    };
    const { context } = createContext(authored);
    const parsed = await parseXlsb(context);
    const summary = parsed.sheets.map((sheet) => ({
      name: sheet.name,
      state: sheet.state,
      ranges: sheet.tables.map(({ range }) => range),
      addresses: sheet.tables.map(({ rows }) => rows.flat().map(({ address }) => address ?? '')),
    }));
    expect(summary).toEqual(expected.sheets);
    await expect(fuzzXlsb(authored)).resolves.toBeUndefined();
  });
});

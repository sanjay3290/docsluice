import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { WarningSink } from '../../../src/core/warnings.js';
import csvReader, {
  parseDelimitedByteChunks,
  parseDelimitedChunks,
  IncrementalDelimitedParser,
  tsvReader,
} from '../../../src/readers/csv/index.js';

async function parse(reader: typeof csvReader, source: string, limits: Record<string, number> = {}) {
  const bytes = new TextEncoder().encode(source);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings });
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder(reader.id, 'text/csv', budget);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

describe('CSV and TSV readers', () => {
  it('parses RFC 4180 quoting, escaped quotes, newlines and CRLF', async () => {
    const { doc, warnings } = await parse(
      csvReader,
      'name,note\r\nAda,"one, two"\r\nLin,"line 1\r\nline 2"\r\nQuote,"say ""hi"""',
    );
    expect(doc.blocks).toEqual([
      {
        kind: 'table',
        headerRows: 0,
        rows: [
          [
            { text: 'name', address: 'A1' },
            { text: 'note', address: 'B1' },
          ],
          [
            { text: 'Ada', address: 'A2' },
            { text: 'one, two', address: 'B2' },
          ],
          [
            { text: 'Lin', address: 'A3' },
            { text: 'line 1\nline 2', address: 'B3' },
          ],
          [
            { text: 'Quote', address: 'A4' },
            { text: 'say "hi"', address: 'B4' },
          ],
        ],
        loc: {},
      },
    ]);
    expect(warnings.map((warning) => warning.code)).not.toContain('UNREADABLE_PART');
  });

  it('sniffs semicolon and pipe, forces tabs for TSV, skips BOM and ignores blank lines', async () => {
    expect((await parse(csvReader, '\uFEFFleft;right\n1;2\n\n3;4')).doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'left' }, { text: 'right' }],
        [{ text: '1' }, { text: '2' }],
        [{ text: '3' }, { text: '4' }],
      ],
    });
    expect((await parse(csvReader, 'a|b\nx|y')).doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'a' }, { text: 'b' }],
        [{ text: 'x' }, { text: 'y' }],
      ],
    });
    expect((await parse(tsvReader, 'a,b\tx\n1\t2')).doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'a,b' }, { text: 'x' }],
        [{ text: '1' }, { text: '2' }],
      ],
    });
    expect((await parse(csvReader, 'a,b\n,\n\n')).doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'a' }, { text: 'b' }],
        [{ text: '' }, { text: '' }],
      ],
    });
    expect((await parse(csvReader, '""\n"",x\n\n')).doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: '' }, { text: '' }],
        [{ text: '' }, { text: 'x' }],
      ],
    });
  });

  it('pads ragged rows and produces spreadsheet addresses through XFD', async () => {
    const header = Array.from({ length: 16384 }, (_, index) => (index === 16383 ? 'last' : '')).join(',');
    const { doc } = await parse(csvReader, `${header}\nx`);
    const table = doc.blocks[0];
    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') {
      expect(table.rows[1]).toHaveLength(16384);
      expect(table.rows[1]?.[16383]).toEqual({ text: '', address: 'XFD2' });
    }
  });

  it('recovers from an unterminated quote with a content-free warning', async () => {
    const { doc, warnings } = await parse(csvReader, 'a,b\n"broken,row\nok,yes');
    expect(doc.blocks).toHaveLength(1);
    expect(warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(warnings)).not.toContain('broken');
  });

  it('stops on cell budget and bounds the partially emitted table', async () => {
    const { doc, warnings } = await parse(csvReader, 'a,b,c\n1,2,3\n4,5,6', { cells: 4 });
    expect(doc.stats.truncated).toBe(true);
    expect(doc.blocks[0]?.kind === 'table' && doc.blocks[0].rows.flat().length).toBeLessThanOrEqual(4);
    expect(warnings.map((warning) => warning.code)).toContain('TRUNCATED');
  });

  it('uses the remaining shared allowance and preserves the child path', async () => {
    const budget = new Budget(resolveLimits({ cells: 2 }));
    budget.addCells(1);
    const out = new DocBuilder('csv', 'text/csv', budget);
    await csvReader.read({
      bytes: new TextEncoder().encode('a,b\nx,y'),
      options: { limits: budget.limits } as ResolvedOptions,
      budget,
      warnings: budget.warnings,
      out,
      path: 'archive/data.csv',
      extractChild: async () => {},
    });
    expect(out.finish()).toMatchObject({
      stats: { truncated: true },
      blocks: [{ loc: { path: 'archive/data.csv' }, rows: [[{ text: 'a' }]] }],
    });
    const throwing = new Budget(resolveLimits({ cells: 0 }), { onLimit: 'throw' });
    await expect(
      csvReader.read({
        bytes: new TextEncoder().encode('a'),
        options: { limits: throwing.limits } as ResolvedOptions,
        budget: throwing,
        warnings: throwing.warnings,
        out: new DocBuilder('csv', 'text/csv', throwing),
        path: '',
        extractChild: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED', limit: 'cells' });
  });

  it('produces identical rows for every UTF-8 chunk split, including CRLF and escaped quotes', () => {
    const text = 'a,b\r\n"☃","x""y"\r\nz,1';
    const expected = [
      ['a', 'b'],
      ['☃', 'x"y'],
      ['z', '1'],
    ];
    for (let split = 0; split <= text.length; split += 1) {
      expect(parseDelimitedChunks([text.slice(0, split), text.slice(split)], ',')).toEqual(expected);
    }
    const bytes = new TextEncoder().encode(text);
    for (let split = 0; split <= bytes.length; split += 1) {
      expect(parseDelimitedByteChunks([bytes.subarray(0, split), bytes.subarray(split)], ',')).toEqual(
        expected,
      );
    }
  });

  it('stops scanning in the same write call when the row callback returns false', () => {
    let rows = 0;
    let ticks = 0;
    const parser = new IncrementalDelimitedParser(',', () => {
      rows += 1;
      return false;
    });
    expect(
      parser.write('a,b\nx,y\nz,w\n', false, () => {
        ticks += 1;
      }),
    ).toBe(false);
    expect(rows).toBe(1);
    expect(ticks).toBe(4);
  });

  it('honors output and abort budgets while scanning', async () => {
    const limited = await parse(csvReader, 'a,b\nlong,value', { outputChars: 2 });
    expect(limited.doc.stats.truncated).toBe(true);
    expect(limited.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits(), { warnings, signal: AbortSignal.abort() });
    const out = new DocBuilder('csv', 'text/csv', budget);
    const ctx = {
      bytes: new TextEncoder().encode('a,b'),
      options: { limits: budget.limits } as ResolvedOptions,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    await expect(csvReader.read(ctx)).rejects.toThrow();
  });
});

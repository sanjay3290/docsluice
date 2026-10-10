import { describe, expect, it } from 'vitest';
import { extract } from '../../../src/core/extract.js';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { ContinuedReader, rkNumber } from '../../../src/readers/xls/biff.js';
import {
  chars,
  compoundFile,
  f64,
  rawHeader,
  record,
  u16,
  u32,
  workbookStream,
  xf,
  xlString,
} from '../../helpers/xls.js';

const read = (stream: Uint8Array, options: Record<string, unknown> = {}) =>
  extract(compoundFile(stream), { filename: 'book.xls', ...options });

const cell = (
  type: number,
  row: number,
  column: number,
  xfIndex: number,
  ...rest: Array<number[] | Uint8Array>
) => record(type, [...u16(row), ...u16(column), ...u16(xfIndex)], ...rest);

const rows = (doc: Awaited<ReturnType<typeof read>>) =>
  doc.blocks.flatMap((block) =>
    block.kind === 'section'
      ? block.blocks.flatMap((inner) =>
          inner.kind === 'table' ? [inner.rows.map((row) => row.map((c) => c.text))] : [],
        )
      : [],
  );

describe('XLS reader', () => {
  it('decodes RK numbers: integers, doubles and the /100 flag', () => {
    expect(rkNumber((42 << 2) | 2)).toBe(42);
    expect(rkNumber((-7 << 2) | 2)).toBe(-7);
    expect(rkNumber((1234 << 2) | 3)).toBe(12.34);
    const high = new DataView(Float64Array.of(1.5).buffer).getUint32(4, true);
    expect(rkNumber(high)).toBe(1.5);
    expect(rkNumber(high | 1)).toBe(0.015);
  });

  it('reads strings split across CONTINUE records, where the width flag can change', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    // "AB" compressed in the first segment, then "€C" as UTF-16 after a new flag byte.
    const first = Uint8Array.from([...u16(4), 0, ...chars('AB', false)]);
    const second = Uint8Array.from([1, ...chars('€C', true)]);
    const reader = new ContinuedReader([first, second], budget);
    expect(reader.richExtendedString()).toBe('AB€C');
    expect(reader.exhausted).toBe(false);
  });

  it('reads shared strings, numbers, RK and MULRK, booleans, errors and cached formula results', async () => {
    const sst = record(
      0x00fc,
      [...u32(3), ...u32(3)],
      [...u16(5), 0, ...chars('Hello', false)],
      [...u16(2), 8, ...u16(1), ...chars('Hi', false), 0, 0, 0, 0],
      [...u16(3), 1, ...chars('Ünï', true)],
    );
    const stream = workbookStream(
      [xf(0), xf(10), sst],
      [
        {
          name: 'Data',
          records: [
            cell(0x00fd, 0, 0, 0, u32(0)),
            cell(0x00fd, 0, 1, 0, u32(1)),
            cell(0x00fd, 0, 2, 0, u32(2)),
            cell(0x0203, 1, 0, 0, f64(2.5)),
            cell(0x027e, 1, 1, 1, u32((25 << 2) | 3)),
            record(0x00bd, [
              ...u16(1),
              ...u16(2),
              ...u16(0),
              ...u32((7 << 2) | 2),
              ...u16(0),
              ...u32((8 << 2) | 2),
              ...u16(3),
            ]),
            cell(0x0205, 2, 0, 0, [1, 0]),
            cell(0x0205, 2, 1, 0, [0x07, 1]),
            cell(0x0006, 2, 2, 0, [0, 0, 0, 0, 0, 0, 0xff, 0xff], [0, 0, 0, 0, 0, 0], [0, 0]),
            record(0x0207, xlString('Cached text')),
            cell(0x0006, 2, 3, 0, [1, 0, 1, 0, 0, 0, 0xff, 0xff], [0, 0, 0, 0, 0, 0], [0, 0]),
            cell(0x0006, 2, 4, 0, f64(9), [0, 0, 0, 0, 0, 0], [0, 0]),
          ],
        },
      ],
    );
    const doc = await read(stream);
    expect(doc.format).toBe('xls');
    expect(rows(doc)).toEqual([
      [
        ['Hello', 'Hi', 'Ünï', '', ''],
        ['2.5', '25.00%', '7', '8', ''],
        ['TRUE', '#DIV/0!', 'Cached text', 'TRUE', '9'],
      ],
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it('keeps sheet order, hidden sheets, merges, the 1904 date system and empty chart sheets', async () => {
    const stream = workbookStream(
      [record(0x0022, u16(1)), xf(0), xf(14), record(0x041e, u16(164), xlString('yyyy-mm-dd'))].concat(
        xf(164),
      ),
      [
        {
          name: 'First',
          records: [
            cell(0x0203, 0, 0, 1, f64(0)),
            cell(0x0203, 0, 1, 2, f64(1)),
            record(0x00e5, u16(1), [...u16(1), ...u16(2), ...u16(0), ...u16(1)]),
          ],
        },
        { name: 'Secret', hidden: 1, records: [cell(0x0203, 0, 0, 0, f64(1))] },
        { name: 'Chart', kind: 2, records: [] },
      ],
    );
    const doc = await read(stream);
    expect(
      doc.blocks.map((block) => (block.kind === 'section' ? [block.title, block.hidden ?? false] : [])),
    ).toEqual([
      ['First', false],
      ['Secret', true],
      ['Chart', false],
    ]);
    const first = doc.blocks[0]!;
    expect(first.kind === 'section' && first.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: '01-01-04', raw: 0 },
          { text: '1904-01-02', raw: 1 },
        ],
      ],
    });
  });

  it('throws for FILEPASS encryption and warns for BIFF5 workbooks', async () => {
    await expect(read(workbookStream([record(0x002f, u16(1))], []))).rejects.toMatchObject({
      code: 'ENCRYPTED',
    });
    const biff5 = await extract(compoundFile(record(0x0809, u16(0x0500), u16(0x0005)), 'Book'), {
      filename: 'old.xls',
    });
    expect(biff5.format).toBe('xls');
    expect(biff5.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('keeps the data before a lying record length, a lying SST count and a bad string index', async () => {
    const sst = record(0x00fc, [...u32(1_000_000), ...u32(1_000_000)], [...u16(2), 0, ...chars('ok', false)]);
    const stream = workbookStream(
      [xf(0), sst],
      [
        {
          name: 'S',
          records: [cell(0x00fd, 0, 0, 0, u32(0)), cell(0x00fd, 0, 1, 0, u32(99)), rawHeader(0x0203, 0xffff)],
        },
      ],
    );
    const doc = await read(stream);
    expect(rows(doc)).toEqual([[['ok', '']]]);
    expect(doc.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('parses a sheet offset only once and stops storing cells at the cells limit', async () => {
    const stream = workbookStream(
      [xf(0)],
      [
        {
          name: 'A',
          records: Array.from({ length: 10 }, (_, index) => cell(0x0203, index, 0, 0, f64(index))),
        },
        { name: 'B', records: [] },
      ],
    );
    // Point the second sheet at the first sheet's offset: it must not be parsed again.
    const bounds: number[] = [];
    for (let index = 0; index + 4 <= stream.length;) {
      const type = stream[index]! | (stream[index + 1]! << 8);
      const length = stream[index + 2]! | (stream[index + 3]! << 8);
      if (type === 0x0085) bounds.push(index + 4);
      if (type === 0x000a) break;
      index += 4 + length;
    }
    const [firstBound = 0, secondBound = 0] = bounds;
    stream.set(stream.subarray(firstBound, firstBound + 4), secondBound);
    const doc = await read(stream, { limits: { cells: 4 } });
    expect(rows(doc)).toHaveLength(1);
    expect(rows(doc)[0]).toHaveLength(4);
    const codes = doc.warnings.map(({ code }) => code);
    expect(codes).toContain('TRUNCATED');
    expect(codes).toContain('UNREADABLE_PART');
  });
});

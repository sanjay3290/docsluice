import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Block, Cell, DocsluiceDocument } from '../../../src/core/model.js';
import { parseXlsbStrings } from '../../../src/readers/xlsb/parse.js';
import { wideString, XlsbRecords } from '../../../src/readers/xlsb/records.js';
import { fuzzXlsb } from '../../../fuzz/xlsb.fuzz.js';
import { makeZip } from '../../helpers/zip.js';
import {
  cell,
  f64,
  part,
  record,
  rowHeader,
  short,
  u16,
  u32,
  wide,
  xlsbPackage,
} from '../../helpers/xlsb.js';

const budget = () => new Budget(DEFAULT_LIMITS);
const sheetData = (...rows: number[][]) => part(record(129), record(145), ...rows, record(146), record(130));

function tables(doc: DocsluiceDocument): Cell[][][] {
  return doc.blocks.flatMap((section: Block) =>
    section.kind === 'section'
      ? section.blocks.flatMap((block) => (block.kind === 'table' ? [block.rows] : []))
      : [],
  );
}

describe('XLSB records', () => {
  it('decodes one- and two-byte types and multi-byte sizes', () => {
    const big = new Array<number>(200).fill(7);
    const records = new XlsbRecords(part(record(0), record(637, big), record(19, [1, 2])), budget());
    expect(records.next()).toEqual({ type: 0, data: new Uint8Array() });
    const second = records.next()!;
    expect(second.type).toBe(637);
    expect(second.data.length).toBe(200);
    expect(records.next()).toEqual({ type: 19, data: Uint8Array.of(1, 2) });
    expect(records.next()).toBeUndefined();
    expect(records.damaged).toBe(false);
  });

  it('stops at a size that runs past the part and at a cut-off header', () => {
    const lying = new XlsbRecords(Uint8Array.of(5, 0xff, 0xff, 0xff, 0x7f, 1, 2), budget());
    expect(lying.next()).toBeUndefined();
    expect(lying.damaged).toBe(true);
    const cut = new XlsbRecords(Uint8Array.of(0x80), budget());
    expect(cut.next()).toBeUndefined();
    expect(cut.damaged).toBe(true);
  });

  it('reads wide strings, null strings and rejects counts past the data', () => {
    expect(wideString(Uint8Array.from(wide('hé')), 0)).toEqual({ text: 'hé', end: 8 });
    expect(wideString(Uint8Array.from(u32(0xffff_ffff)), 0)).toEqual({ text: null, end: 4 });
    expect(wideString(Uint8Array.from(u32(5)), 0)).toBeUndefined();
    expect(wideString(Uint8Array.of(1, 2), 0)).toBeUndefined();
  });
});

describe('XLSB reader', () => {
  it('reads every cell kind, long and short, with styles and shared strings', async () => {
    const styles = part(
      record(278),
      record(615),
      record(44, [...u16(164), ...wide('0.0%')]),
      record(616),
      record(626),
      record(47, [...u16(0xffff), ...u16(0), ...new Array<number>(12).fill(0)]),
      record(627),
      record(617),
      record(47, [...u16(0), ...u16(0), ...new Array<number>(12).fill(0)]),
      record(47, [...u16(0), ...u16(164), ...new Array<number>(12).fill(0)]),
      record(618),
      record(279),
    );
    const doc = await extract(
      xlsbPackage(
        [
          {
            name: 'Cells',
            data: sheetData(
              rowHeader(0),
              cell(7, 0, 0, ...u32(0)),
              cell(2, 1, 0, ...u32((42 << 2) | 2)),
              cell(5, 2, 1, ...f64(0.125)),
              cell(4, 3, 0, 1),
              cell(3, 4, 0, 0x07),
              cell(6, 5, 0, ...wide('inline')),
              cell(1, 6, 0),
              rowHeader(1),
              cell(9, 0, 0, ...f64(2.5), ...u16(0), ...u32(0), ...u32(0)),
              cell(8, 1, 0, ...wide('fx'), ...u16(0), ...u32(0), ...u32(0)),
              cell(10, 2, 0, 0, ...u16(0), ...u32(0), ...u32(0)),
              cell(11, 3, 0, 0x2a, ...u16(0), ...u32(0), ...u32(0)),
              rowHeader(2),
              cell(7, 1, 0, ...u32(0)),
              short(18, 0, ...u32(0)),
              short(13, 0, ...u32((7 << 2) | 2)),
              short(16, 1, ...f64(0.5)),
              short(15, 0, 0),
              short(14, 0, 0x17),
              short(17, 0, ...wide('st')),
              short(12, 0),
              short(18, 0, ...u32(0)),
            ),
          },
        ],
        { strings: ['shared'], styles },
      ),
    );
    expect(doc.format).toBe('xlsb');
    const rows = tables(doc)[0]!.map((cells) => cells.map((value) => [value.text, value.raw, value.address]));
    expect(rows).toEqual([
      [
        ['shared', undefined, 'A1'],
        ['42', 42, 'B1'],
        ['12.5%', 0.125, 'C1'],
        ['TRUE', true, 'D1'],
        ['#DIV/0!', undefined, 'E1'],
        ['inline', undefined, 'F1'],
        ['', undefined, 'G1'],
        ['', undefined, 'H1'],
        ['', undefined, 'I1'],
        ['', undefined, 'J1'],
      ],
      [
        ['2.5', 2.5, 'A2'],
        ['fx', undefined, 'B2'],
        ['FALSE', false, 'C2'],
        ['#N/A', undefined, 'D2'],
        ['', undefined, 'E2'],
        ['', undefined, 'F2'],
        ['', undefined, 'G2'],
        ['', undefined, 'H2'],
        ['', undefined, 'I2'],
        ['', undefined, 'J2'],
      ],
      [
        ['', undefined, 'A3'],
        ['shared', undefined, 'B3'],
        ['shared', undefined, 'C3'],
        ['7', 7, 'D3'],
        ['50.0%', 0.5, 'E3'],
        ['FALSE', false, 'F3'],
        ['#REF!', undefined, 'G3'],
        ['st', undefined, 'H3'],
        ['', undefined, 'I3'],
        ['shared', undefined, 'J3'],
      ],
    ]);
    expect(doc.warnings).toEqual([]);
  });

  it('keeps merges, sheet states, module sheets and the 1904 date system', async () => {
    const styles = part(
      record(617),
      record(47, [...u16(0), ...u16(14), ...new Array<number>(12).fill(0)]),
      record(618),
    );
    const doc = await extract(
      xlsbPackage(
        [
          {
            name: 'Merged',
            data: part(
              record(145),
              rowHeader(0),
              cell(7, 0, 0, ...u32(0)),
              cell(5, 2, 0, ...f64(0), ...[]),
              record(146),
              record(177, u32(1)),
              record(176, [...u32(0), ...u32(1), ...u32(0), ...u32(1)]),
              record(176, [...u32(5), ...u32(1), ...u32(0), ...u32(0)]),
              record(178),
            ),
          },
          { name: 'Hidden', state: 1, data: sheetData(rowHeader(0), cell(5, 0, 0, ...f64(0))) },
          { name: 'VeryHidden', state: 2, data: sheetData() },
          { name: 'Module', state: 2, data: null },
        ],
        { strings: ['head'], styles, date1904: true },
      ),
    );
    expect(
      doc.blocks.map((block) => (block.kind === 'section' ? [block.title, block.hidden] : null)),
    ).toEqual([
      ['Merged', undefined],
      ['Hidden', true],
      ['VeryHidden', 'very'],
      ['Module', 'very'],
    ]);
    expect(tables(doc)[0]![0]).toMatchObject([
      // The merge is clipped to the table, which holds row 1 only, as in XLSX.
      { text: 'head', colSpan: 2 },
      { text: '' },
      { text: '01-01-04' },
    ]);
    expect(tables(doc)[1]![0]![0]!.text).toBe('01-01-04');
  });

  it('warns about damaged records and out-of-range shared strings, keeping what was read', async () => {
    const doc = await extract(
      xlsbPackage(
        [
          {
            name: 'Damaged',
            data: Uint8Array.from([
              ...record(145),
              ...rowHeader(0),
              ...cell(7, 0, 0, ...u32(9)),
              ...cell(5, 1, 0, ...f64(3)),
              ...record(5, [1, 2]),
              5,
              0xff,
              0x7f,
            ]),
          },
        ],
        { strings: ['only'] },
      ),
    );
    expect(tables(doc)[0]![0]!.map((value) => value.text)).toEqual(['', '3']);
    expect(doc.warnings.map((warning) => warning.message)).toEqual([
      'A shared-string index is out of range; the cell is empty.',
      'Some workbook records are damaged; the data read before them is kept.',
    ]);
  });

  it('stops storing cells at the cells limit and throws with onLimit throw', async () => {
    const rows = Array.from({ length: 20 }, (_, row) => [...rowHeader(row), ...cell(5, 0, 0, ...f64(row))]);
    const bytes = xlsbPackage([{ name: 'S', data: sheetData(...rows) }]);
    const doc = await extract(bytes, { limits: { cells: 5 } });
    expect(tables(doc)[0]).toHaveLength(5);
    expect(doc.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
    await expect(extract(bytes, { limits: { cells: 5 }, onLimit: 'throw' })).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  });

  it('reads shared strings with rich runs and stops at a damaged item', () => {
    const rich = [1, ...wide('rich'), ...u32(1), ...u16(0), ...u16(0)];
    const result = parseXlsbStrings(
      part(record(159), record(19, rich), record(19, [0, ...u32(50)]), record(19, [0, ...wide('x')])),
      budget(),
    );
    expect(result).toEqual({ strings: ['rich'], damaged: true });
  });

  it('warns when the workbook part is missing', async () => {
    const bytes = makeZip([
      {
        name: '[Content_Types].xml',
        data: new TextEncoder().encode(
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>',
        ),
      },
      { name: 'xl/other.bin', data: Uint8Array.of(0) },
    ]);
    const doc = await extract(bytes, { format: 'xlsb' });
    expect(doc.warnings.map((warning) => warning.message)).toEqual(['The workbook part could not be read.']);
  });

  it('survives the fuzz target on packages and raw parts', async () => {
    await expect(
      fuzzXlsb(xlsbPackage([{ name: 'S', data: sheetData(rowHeader(0), cell(5, 0, 0, ...f64(1))) }])),
    ).resolves.toBeUndefined();
    await expect(fuzzXlsb(sheetData(rowHeader(0), short(13, 0, ...u32(2))))).resolves.toBeUndefined();
    await expect(fuzzXlsb(Uint8Array.of(0xff, 0xff, 0xff))).resolves.toBeUndefined();
  });
});

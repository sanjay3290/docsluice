import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  UnsupportedFormatError,
} from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { openCfb } from '../../../src/ole/index.js';
import { xlsReader } from '../../../src/readers/xls/index.js';

const MIME = 'application/vnd.ms-excel';
const BOF = 0x0809;
const EOF = 0x000a;
const BOUNDSHEET8 = 0x0085;

function record(id: number, payload: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + payload.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, payload.length, true);
  bytes.set(payload, 4);
  return bytes;
}

function stream(records: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(records.reduce((size, item) => size + item.length, 0));
  let offset = 0;
  for (const item of records) {
    bytes.set(item, offset);
    offset += item.length;
  }
  return bytes;
}

function bof(type: number): Uint8Array {
  const payload = new Uint8Array(16);
  const view = new DataView(payload.buffer);
  view.setUint16(0, 0x0600, true);
  view.setUint16(2, type, true);
  return record(BOF, payload);
}

function stringRecord(value: string, highByte = false): Uint8Array {
  const payload = new Uint8Array(3 + value.length * (highByte ? 2 : 1));
  const view = new DataView(payload.buffer);
  view.setUint16(0, value.length, true);
  payload[2] = highByte ? 1 : 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    payload[3 + index * (highByte ? 2 : 1)] = code & 0xff;
    if (highByte) payload[4 + index * 2] = code >>> 8;
  }
  return payload;
}

interface SheetSpec {
  name: string;
  state?: number;
  records: Uint8Array[];
}

function workbook(sheets: SheetSpec[], globals: Uint8Array[] = []): Uint8Array {
  const makeBound = (sheet: SheetSpec, offset: number) => {
    const payload = new Uint8Array(8 + sheet.name.length);
    const view = new DataView(payload.buffer);
    view.setUint32(0, offset, true);
    payload[4] = sheet.state ?? 0;
    payload[5] = 0;
    payload[6] = sheet.name.length;
    payload[7] = 0;
    for (let index = 0; index < sheet.name.length; index += 1)
      payload[8 + index] = sheet.name.charCodeAt(index);
    return record(BOUNDSHEET8, payload);
  };
  const fixedBoundRecords = sheets.map((sheet) => makeBound(sheet, 0));
  const globalPrefix = [bof(0x0005), ...globals];
  const globalLength = stream([...globalPrefix, ...fixedBoundRecords, record(EOF, new Uint8Array())]).length;
  let offset = globalLength;
  const boundRecords = sheets.map((sheet) => {
    const bound = makeBound(sheet, offset);
    offset += stream([bof(0x0010), ...sheet.records, record(EOF, new Uint8Array())]).length;
    return bound;
  });
  const globalStream = [...globalPrefix, ...boundRecords, record(EOF, new Uint8Array())];
  return stream([
    ...globalStream,
    ...sheets.flatMap((sheet) => [bof(0x0010), ...sheet.records, record(EOF, new Uint8Array())]),
  ]);
}

function cellPrefix(row: number, col: number, xf = 0): Uint8Array {
  const payload = new Uint8Array(6);
  const view = new DataView(payload.buffer);
  view.setUint16(0, row, true);
  view.setUint16(2, col, true);
  view.setUint16(4, xf, true);
  return payload;
}

function numberCell(id: number, row: number, col: number, value: number, xf = 0): Uint8Array {
  const payload = new Uint8Array(14);
  payload.set(cellPrefix(row, col, xf));
  new DataView(payload.buffer).setFloat64(6, value, true);
  return record(id, payload);
}

function formulaCell(row: number, col: number, value: number, tokens: Uint8Array): Uint8Array {
  const payload = new Uint8Array(22 + tokens.length);
  payload.set(cellPrefix(row, col));
  new DataView(payload.buffer).setFloat64(6, value, true);
  new DataView(payload.buffer).setUint16(20, tokens.length, true);
  payload.set(tokens, 22);
  return record(0x0006, payload);
}

function withContext(
  workbookBytes: Uint8Array,
  options: Partial<ReadContext['options']> = {},
  limitOverrides: Parameters<typeof resolveLimits>[0] = {},
) {
  const warnings = new WarningSink();
  const limits = resolveLimits(limitOverrides);
  const budget = new Budget(limits, { warnings });
  const out = new DocBuilder('xls', MIME, budget);
  const context = {
    bytes: new Uint8Array(),
    options: {
      limits,
      onLimit: 'truncate',
      strict: false,
      metadata: true,
      children: 'extract',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: false,
      formulas: false,
      ...options,
    },
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(undefined),
    cfb: {
      entries: [{ path: 'Workbook', size: workbookBytes.byteLength, type: 'stream' }],
      read: (path: string) => (path === 'Workbook' ? workbookBytes : new Uint8Array()),
    },
  } as unknown as ReadContext;
  return { context, document: () => out.finish(), budget };
}

async function readSynthetic(
  bytes: Uint8Array,
  options: Partial<ReadContext['options']> = {},
  limitOverrides: Parameters<typeof resolveLimits>[0] = {},
) {
  const result = withContext(bytes, options, limitOverrides);
  await xlsReader.read(result.context);
  return { document: result.document(), budget: result.budget };
}

describe('BIFF8 XLS reader', () => {
  it('keeps BoundSheet order and hidden state while emitting sparse addressed tables', async () => {
    const bytes = workbook([
      {
        name: 'Second',
        state: 2,
        records: [numberCell(0x0203, 65_535, 255, 12.5), numberCell(0x0203, 0, 0, 7)],
      },
      { name: 'First', state: 0, records: [numberCell(0x0203, 2, 1, 99)] },
    ]);
    const { document } = await readSynthetic(bytes);
    const sheets = document.blocks.filter((block) => block.kind === 'section');
    expect(sheets.map((sheet) => sheet.title)).toEqual(['Second', 'First']);
    const second = sheets[0]!;
    const tables = second.blocks.filter((block) => block.kind === 'table');
    expect(tables).toHaveLength(2);
    if (tables[0]?.kind === 'table' && tables[1]?.kind === 'table') {
      expect(tables[0].loc).toEqual(expect.objectContaining({ sheet: 'Second', range: 'A1' }));
      expect(tables[0].rows[0]?.[0]).toMatchObject({ address: 'A1', raw: 7 });
      expect(tables[1].loc).toEqual(expect.objectContaining({ sheet: 'Second', range: 'IV65536' }));
      expect(tables[1].rows[0]?.[0]).toMatchObject({ address: 'IV65536', raw: 12.5 });
    }
    expect(document.warnings.some((warning) => warning.code === 'HIDDEN_CONTENT')).toBe(true);
  });

  it('coalesces matching adjacent row runs into rectangular sparse tables', async () => {
    const { document } = await readSynthetic(
      workbook([
        {
          name: 'Rectangles',
          records: [
            numberCell(0x0203, 1, 0, 1),
            numberCell(0x0203, 1, 1, 2),
            numberCell(0x0203, 2, 0, 3),
            numberCell(0x0203, 2, 1, 4),
            numberCell(0x0203, 5, 4, 6),
          ],
        },
      ]),
    );
    const tables = document.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .filter((block) => block.kind === 'table');
    expect(tables).toHaveLength(2);
    if (tables[0]?.kind === 'table' && tables[1]?.kind === 'table') {
      expect(tables[0].loc.range).toBe('A2:B3');
      expect(tables[0].rows.map((row) => row.map((cell) => cell.raw))).toEqual([
        [1, 2],
        [3, 4],
      ]);
      expect(tables[1].loc.range).toBe('E6');
    }
  });

  it('uses cached formula values and only emits a decoded formula expression when requested', async () => {
    const tokens = Uint8Array.of(0x1e, 1, 0, 0x1e, 1, 0, 0x03);
    const bytes = workbook([
      {
        name: 'Calc',
        records: [
          formulaCell(0, 0, 5, tokens),
          record(
            0x0006,
            (() => {
              const payload = new Uint8Array(22);
              payload.set(cellPrefix(1, 0));
              payload[6] = 0;
              payload[12] = 0xff;
              payload[13] = 0xff;
              payload[20] = 0;
              return payload;
            })(),
          ),
          record(0x0207, stringRecord('cached string', true)),
        ],
      },
    ]);
    const { document } = await readSynthetic(bytes, { formulas: true });
    const tables = document.blocks.flatMap((block) => (block.kind === 'section' ? block.blocks : []));
    const cells = tables.flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []));
    expect(cells).toMatchObject([
      { address: 'A1', text: '5', raw: 5, formula: '(1+1)' },
      { address: 'A2', text: 'cached string', raw: 'cached string' },
    ]);
  });

  it('decodes RK/MULRK values, booleans, errors, labels and merged ranges', async () => {
    const rk = (value: number) => {
      const payload = cellPrefix(0, 0);
      const bytes = new Uint8Array(10);
      bytes.set(payload);
      new DataView(bytes.buffer).setUint32(6, ((value << 2) | 0x02) >>> 0, true);
      return record(0x027e, bytes);
    };
    const boolErr = new Uint8Array(8);
    boolErr.set(cellPrefix(1, 0));
    boolErr[6] = 1;
    boolErr[7] = 0;
    const merge = new Uint8Array(10);
    new DataView(merge.buffer).setUint16(0, 1, true);
    new DataView(merge.buffer).setUint16(2, 2, true);
    new DataView(merge.buffer).setUint16(4, 4, true);
    new DataView(merge.buffer).setUint16(6, 3, true);
    new DataView(merge.buffer).setUint16(8, 5, true);
    const label = new Uint8Array(14);
    label.set(cellPrefix(2, 3));
    new DataView(label.buffer).setUint16(6, 5, true);
    label[8] = 0;
    label.set(new TextEncoder().encode('Label'), 9);
    const mulRk = new Uint8Array(18);
    const mulView = new DataView(mulRk.buffer);
    mulView.setUint16(0, 2, true);
    mulView.setUint16(2, 1, true);
    mulView.setUint16(4, 0, true);
    mulView.setUint32(6, (42 << 2) | 2, true);
    mulView.setUint16(10, 0, true);
    mulView.setUint32(12, (7 << 2) | 2, true);
    mulView.setUint16(16, 2, true);
    const { document } = await readSynthetic(
      workbook([
        {
          name: 'Values',
          records: [
            rk(42),
            record(0x00bd, mulRk),
            record(0x0205, boolErr),
            record(0x0204, label),
            record(0x00e5, merge),
          ],
        },
      ]),
    );
    const tables = document.blocks.flatMap((block) => (block.kind === 'section' ? block.blocks : []));
    const cells = tables.flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []));
    expect(cells.map((cell) => [cell.address, cell.text, cell.raw])).toEqual([
      ['A1', '42', 42],
      ['A2', 'TRUE', true],
      ['B3', '42', 42],
      ['C3', '7', 7],
      ['D3', 'Label', 'Label'],
    ]);
    expect(cells).toContainEqual(
      expect.objectContaining({ address: 'D3', text: 'Label', rowSpan: 3, colSpan: 3 }),
    );
  });

  it('maps the BIFF error codes and decodes the supported formula token forms', async () => {
    const errorCodes = [0x00, 0x07, 0x0f, 0x17, 0x1d, 0x24, 0x2a, 0x01];
    const expectedErrors = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#ERROR!'];
    const errors = errorCodes.map((code, col) => {
      const payload = new Uint8Array(8);
      payload.set(cellPrefix(0, col));
      payload[6] = code;
      payload[7] = 1;
      return record(0x0205, payload);
    });
    const floatToken = new Uint8Array(9);
    floatToken[0] = 0x1f;
    new DataView(floatToken.buffer).setFloat64(1, 2.5, true);
    const textToken = Uint8Array.of(0x17, 3, 0, 65, 34, 66);
    const tokens = [
      Uint8Array.of(0x1e, 2, 0, 0x12),
      Uint8Array.of(0x1e, 3, 0, 0x13),
      Uint8Array.of(0x1e, 5, 0, 0x14),
      Uint8Array.of(0x1e, 5, 0, 0x15),
      floatToken,
      textToken,
    ];
    const formulas = tokens.map((token, index) => formulaCell(index + 1, 0, 10 + index, token));
    const { document } = await readSynthetic(
      workbook([{ name: 'Types', records: [...errors, ...formulas] }]),
      { formulas: true },
    );
    const cells = document.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []));
    expect(cells.slice(0, errorCodes.length).map((cell) => cell.text)).toEqual(expectedErrors);
    expect(cells.slice(errorCodes.length).map((cell) => cell.formula)).toEqual([
      '+2',
      '-3',
      '5%',
      '(5)',
      '2.5',
      '"A""B"',
    ]);
  });

  it('rejects bad bound offsets, shared-string indexes, encryption and unsupported BIFF versions', async () => {
    const badOffset = workbook([{ name: 'Bad', records: [] }]);
    new DataView(badOffset.buffer).setUint32(24, 7, true);
    await expect(readSynthetic(badOffset)).rejects.toBeInstanceOf(CorruptFileError);

    const badStateFlags = workbook([{ name: 'Bad state', records: [] }]);
    badStateFlags[28] = 0x84;
    await expect(readSynthetic(badStateFlags)).rejects.toBeInstanceOf(CorruptFileError);

    const sharedIndex = new Uint8Array(10);
    sharedIndex.set(cellPrefix(0, 0));
    new DataView(sharedIndex.buffer).setUint32(6, 4, true);
    const badStringIndex = await readSynthetic(
      workbook([{ name: 'Bad index', records: [record(0x00fd, sharedIndex)] }]),
    );
    expect(badStringIndex.document.warnings.some((warning) => warning.code === 'UNREADABLE_PART')).toBe(true);

    await expect(
      readSynthetic(stream([bof(0x0005), record(0x002f, new Uint8Array()), record(EOF, new Uint8Array())])),
    ).rejects.toBeInstanceOf(EncryptedError);

    const old = bof(0x0005);
    new DataView(old.buffer).setUint16(4, 0x0500, true);
    await expect(readSynthetic(stream([old, record(EOF, new Uint8Array())]))).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  it('rejects non-finite values encoded in RK records', async () => {
    const payload = new Uint8Array(10);
    payload.set(cellPrefix(0, 0));
    new DataView(payload.buffer).setUint32(6, 0x7ff0_0000, true);
    const { document } = await readSynthetic(
      workbook([{ name: 'Bad RK', records: [record(0x027e, payload)] }]),
    );
    const cells = document.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .filter((block) => block.kind === 'table');
    expect(cells).toEqual([]);
    expect(document.warnings.some((warning) => warning.code === 'UNREADABLE_PART')).toBe(true);
  });

  it('preflights retained cell text against the shared output budget', async () => {
    const mulRk = new Uint8Array(18);
    const mulView = new DataView(mulRk.buffer);
    mulView.setUint16(0, 5, true);
    mulView.setUint16(2, 1, true);
    mulView.setUint32(6, (1 << 2) | 2, true);
    mulView.setUint32(12, (2 << 2) | 2, true);
    mulView.setUint16(16, 2, true);
    const { document } = await readSynthetic(
      workbook([
        {
          name: 'X',
          records: [
            numberCell(0x0203, 0, 0, 123),
            numberCell(0x0203, 4, 3, 456),
            record(0x00bd, mulRk),
            record(0x1234, new Uint8Array()),
          ],
        },
      ]),
      {},
      { outputChars: 2 },
    );
    const sections = document.blocks.filter((block) => block.kind === 'section');
    expect(sections[0]?.blocks).toEqual([]);
    expect(document.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
    expect(
      document.warnings.some((warning) => warning.message.includes('omitted 4 cells across 3 rows')),
    ).toBe(true);
  });

  it('charges retained formula text once and preflights it with cell text and sheet titles', async () => {
    const formula = formulaCell(0, 0, 5, Uint8Array.of(0x1e, 1, 0, 0x1e, 1, 0, 0x03));
    const source = workbook([{ name: 'C', records: [formula] }]);
    const accepted = await readSynthetic(source, { formulas: true }, { outputChars: 7 });
    expect(accepted.budget.outputChars).toBe(7);

    const limited = await readSynthetic(source, { formulas: true }, { outputChars: 6 });
    const section = limited.document.blocks.find((block) => block.kind === 'section');
    expect(section?.kind === 'section' ? section.blocks : []).toEqual([]);
    expect(limited.budget.outputChars).toBe(1);
  });

  it('rejects duplicate empty SST records', async () => {
    const emptySst = record(0x00fc, new Uint8Array(8));
    await expect(
      readSynthetic(workbook([{ name: 'Empty SST', records: [] }], [emptySst, emptySst])),
    ).rejects.toBeInstanceOf(CorruptFileError);
  });

  it('throws on the reader-owned per-sheet and workbook cell caps', async () => {
    const cells = (count: number, start: number) =>
      Array.from({ length: count }, (_, index) => numberCell(0x0203, start + index, 0, index));
    await expect(
      readSynthetic(workbook([{ name: 'Over sheet cap', records: cells(50_001, 0) }])),
    ).rejects.toBeInstanceOf(LimitExceededError);
    await expect(
      readSynthetic(
        workbook([
          { name: 'First', records: cells(50_000, 0) },
          { name: 'Second', records: cells(50_000, 0) },
          { name: 'Third', records: cells(1, 0) },
        ]),
      ),
    ).rejects.toBeInstanceOf(LimitExceededError);
  }, 30_000);

  it('caps retained merge anchors cumulatively across MERGECELLS records', async () => {
    const records: Uint8Array[] = [];
    for (let start = 0; start < 50_001; start += 1_024) {
      const count = Math.min(1_024, 50_001 - start);
      const payload = new Uint8Array(2 + count * 8);
      new DataView(payload.buffer).setUint16(0, count, true);
      for (let index = 0; index < count; index += 1) {
        const row = start + index;
        const offset = 2 + index * 8;
        new DataView(payload.buffer).setUint16(offset, row, true);
        new DataView(payload.buffer).setUint16(offset + 2, row, true);
      }
      records.push(record(0x00e5, payload));
    }
    await expect(readSynthetic(workbook([{ name: 'Many merges', records }]))).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  }, 30_000);

  it('bounds and decodes long inline Unicode labels in chunks', async () => {
    const text = 'L'.repeat(5_000);
    const payload = new Uint8Array(9 + text.length);
    payload.set(cellPrefix(0, 0));
    new DataView(payload.buffer).setUint16(6, text.length, true);
    payload[8] = 0;
    payload.set(new TextEncoder().encode(text), 9);
    const { document } = await readSynthetic(
      workbook([{ name: 'Long', records: [record(0x0204, payload)] }]),
    );
    const cell = document.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []))[0];
    expect(cell?.text).toBe(text);
  });

  it('applies the workbook 1904 date system and built-in date formats', async () => {
    const datemode = record(0x0022, Uint8Array.of(1, 0));
    const xfData = new Uint8Array(4);
    new DataView(xfData.buffer).setUint16(2, 14, true);
    const { document } = await readSynthetic(
      workbook(
        [{ name: 'Dates', records: [numberCell(0x0203, 0, 0, 0)] }],
        [datemode, record(0x00e0, xfData)],
      ),
    );
    const cells = document.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []));
    expect(cells).toMatchObject([{ address: 'A1', text: '01-01-04', raw: 0 }]);
  });

  it('reads the LibreOffice BIFF8 fixture using its embedded Workbook stream', async () => {
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('./fixtures/biff8-source.xls', import.meta.url))),
    );
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits(), { warnings });
    const cfb = openCfb(bytes, budget);
    const out = new DocBuilder('xls', MIME, budget);
    const context = {
      bytes,
      options: {
        limits: resolveLimits(),
        onLimit: 'truncate',
        strict: false,
        metadata: true,
        children: 'extract',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
        formulas: true,
      },
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(undefined),
      cfb,
    } as unknown as ReadContext;
    await xlsReader.read(context);
    const document = out.finish();
    const sheets = document.blocks.filter((block) => block.kind === 'section');
    expect(sheets.map((sheet) => sheet.title)).toEqual(['Visible', 'Hidden', '__proto__']);
    expect(sheets[1]?.hidden).toBe(true);
    expect(document.warnings.some((warning) => warning.code === 'HIDDEN_CONTENT')).toBe(true);
    const cells = sheets.flatMap((sheet) =>
      sheet.blocks.flatMap((block) => (block.kind === 'table' ? block.rows.flat() : [])),
    );
    expect(cells).toContainEqual(expect.objectContaining({ address: 'B2', text: '42.25', raw: 42.25 }));
    expect(cells).toContainEqual(expect.objectContaining({ address: 'A3', text: 'TRUE', raw: true }));
    expect(cells).toContainEqual(expect.objectContaining({ address: 'B3', text: '#DIV/0!' }));
    expect(cells).toContainEqual(expect.objectContaining({ address: 'B4', text: '1900-03-01' }));
    expect(cells.some((cell) => cell.text.length === 20_017)).toBe(true);
    expect(cells).toContainEqual(expect.objectContaining({ address: 'D7', colSpan: 2, rowSpan: 2 }));
  });
});

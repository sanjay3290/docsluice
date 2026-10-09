import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbortError, CorruptFileError, LimitExceededError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { iterXlsbRecords, XlsbCursor } from '../../../src/readers/xlsb/records.js';

function budget(signal?: AbortSignal): Budget {
  return new Budget(DEFAULT_LIMITS, { signal });
}

function record(type: number, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const typeBytes = type < 128 ? [type] : [0x80 | (type & 0x7f), (type >>> 7) & 0x7f];
  const length = payload.length;
  const sizeBytes = [length & 0x7f];
  let remaining = length >>> 7;
  while (remaining > 0) {
    const last = sizeBytes.length - 1;
    sizeBytes[last] = sizeBytes[last]! | 0x80;
    sizeBytes.push(remaining & 0x7f);
    remaining >>>= 7;
  }
  const header = Uint8Array.from([...typeBytes, ...sizeBytes]);
  const bytes = new Uint8Array(header.length + payload.length);
  bytes.set(header);
  bytes.set(payload, header.length);
  return bytes;
}

describe('XLSB binary records', () => {
  it('decodes the MS-XLSB 2.1.4 record header example', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/record-comment-text-example.bin', import.meta.url)),
    );
    const records = [...iterXlsbRecords(bytes, budget())];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ type: 637, offset: 0 });
    expect(records[0]?.data).toHaveLength(200);
  });

  it('decodes one- and two-byte record types and preserves the stream offset', () => {
    const bytes = Uint8Array.from([...record(127), ...record(128), ...record(16_383)]);
    expect(
      [...iterXlsbRecords(bytes, budget())].map(({ type, offset, data }) => [type, offset, data.length]),
    ).toEqual([
      [127, 0, 0],
      [128, 2, 0],
      [16_383, 5, 0],
    ]);
  });

  it('rejects two-byte type encodings below the minimum two-byte value', () => {
    expect(() => [...iterXlsbRecords(Uint8Array.from([0x80, 0x00, 0x00]), budget())]).toThrow(
      CorruptFileError,
    );
  });

  it.each([0, 127, 128, 16_384])('decodes a %i-byte record data length', (length) => {
    const parsed = [...iterXlsbRecords(record(1, new Uint8Array(length)), budget())];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.data).toHaveLength(length);
  });

  it('decodes the four-byte size form at the 2^21 boundary', () => {
    const length = 2 ** 21;
    const parsed = [...iterXlsbRecords(record(1, new Uint8Array(length)), budget())];
    expect(parsed[0]?.data).toHaveLength(length);
  });

  it('accepts an empty part with no records', () => {
    expect([...iterXlsbRecords(new Uint8Array(), budget())]).toEqual([]);
  });

  it('ignores the high bit of the fourth size byte as MS-XLSB specifies', () => {
    expect([...iterXlsbRecords(Uint8Array.from([1, 0x80, 0x80, 0x80, 0x80]), budget())]).toMatchObject([
      { type: 1, offset: 0, data: new Uint8Array() },
    ]);
  });

  it.each([
    Uint8Array.from([0x80]),
    Uint8Array.from([1, 0x80]),
    Uint8Array.from([1, 0x80, 0x80]),
    Uint8Array.from([1, 0x80, 0x80, 0x80]),
    Uint8Array.from([0x80, 0x80, 0]),
  ])('rejects an empty or truncated/invalid record header: %s', (bytes) => {
    expect(() => [...iterXlsbRecords(bytes, budget())]).toThrow(CorruptFileError);
  });

  it('checks record payload lengths before creating payload views', () => {
    expect(() => [...iterXlsbRecords(Uint8Array.from([1, 10, 0]), budget())]).toThrow(CorruptFileError);
  });

  it('rejects a record count beyond the documented cap', () => {
    const count = 1_000_001;
    const bytes = new Uint8Array(count * 2);
    for (let index = 0; index < bytes.length; index += 2) {
      bytes[index] = 0;
      bytes[index + 1] = 0;
    }
    let parsed = 0;
    let caught: unknown;
    try {
      for (const unused of iterXlsbRecords(bytes, budget())) {
        void unused;
        parsed += 1;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LimitExceededError);
    expect((caught as LimitExceededError).limit).toBe('xlsbRecordCount');
    expect((caught as LimitExceededError).value).toBe(1_000_000);
    expect(parsed).toBe(1_000_000);
  });

  it('reads little-endian scalar fields from a subarray with a nonzero backing offset', () => {
    const backing = Uint8Array.from([
      0xee, 0x7a, 0x34, 0x12, 0x78, 0x56, 0x34, 0x12, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x3f,
    ]);
    const cursor = new XlsbCursor(backing.subarray(1), budget());
    expect(cursor.readU8()).toBe(0x7a);
    expect(cursor.readU16()).toBe(0x1234);
    expect(cursor.readU32()).toBe(0x12345678);
    expect(cursor.readF64()).toBe(1);
    expect(cursor.offset).toBe(15);
    expect(cursor.remaining).toBe(0);
  });

  it('rejects Xnum infinities, NaN, denormalized values, and negative zero', () => {
    for (const bits of [0x7ff0_0000_0000_0000n, 0x7ff8_0000_0000_0000n, 1n, 0x8000_0000_0000_0000n]) {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setBigUint64(0, bits, true);
      expect(() => new XlsbCursor(bytes, budget()).readF64()).toThrow(CorruptFileError);
    }
    expect(new XlsbCursor(new Uint8Array(8), budget()).readF64()).toBe(0);
  });

  it('reads XLWideString with Unicode surrogate pairs and retains a leading BOM', () => {
    const bytes = Uint8Array.from([3, 0, 0, 0, 0x41, 0, 0x3d, 0xd8, 0x00, 0xde]);
    expect(new XlsbCursor(bytes, budget()).readWideString()).toBe('A😀');
    const bomBytes = Uint8Array.from([1, 0, 0, 0, 0xff, 0xfe]);
    expect(new XlsbCursor(bomBytes, budget()).readWideString()).toBe('\uFEFF');
  });

  it('distinguishes nullable null strings from empty wide strings', () => {
    const nullable = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
    const empty = Uint8Array.from([0, 0, 0, 0]);
    expect(new XlsbCursor(nullable, budget()).readNullableWideString()).toBeNull();
    expect(new XlsbCursor(empty, budget()).readNullableWideString()).toBe('');
    expect(new XlsbCursor(empty, budget()).readWideString()).toBe('');
  });

  it.each([
    Uint8Array.from([0xff, 0xff, 0xff, 0xff]),
    Uint8Array.from([1, 0, 0, 0, 0x41]),
    Uint8Array.from([1, 0, 0, 0, 0, 0xd8]),
  ])('rejects invalid, truncated, or malformed UTF-16 strings', (bytes) => {
    expect(() => new XlsbCursor(bytes, budget()).readWideString()).toThrow(CorruptFileError);
  });

  it('raises a named limit error for a string beyond the defensive code-unit cap', () => {
    const bytes = Uint8Array.from([0x41, 0x42, 0x0f, 0]);
    let caught: unknown;
    try {
      new XlsbCursor(bytes, budget()).readWideString();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LimitExceededError);
    expect((caught as LimitExceededError).limit).toBe('xlsbStringCodeUnits');
    expect((caught as LimitExceededError).value).toBe(1_000_000);
  });

  it('propagates caller cancellation during record and field scanning', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => [...iterXlsbRecords(record(1), budget(controller.signal))]).toThrow(AbortError);
    expect(() => new XlsbCursor(Uint8Array.from([1]), budget(controller.signal)).readU8()).toThrow(
      AbortError,
    );

    let checks = 0;
    const delayedAbort = {
      get aborted(): boolean {
        checks += 1;
        return checks > 2;
      },
      reason: 'stop while scanning',
    } as AbortSignal;
    expect(() => [...iterXlsbRecords(record(127, new Uint8Array(4)), budget(delayedAbort))]).toThrow(
      AbortError,
    );
  });
});

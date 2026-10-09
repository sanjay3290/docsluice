import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AbortError, CorruptFileError, LimitExceededError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { openCfb } from '../../../src/ole/index.js';
import { iterateBiffRecords } from '../../../src/readers/xls/records.js';
import { readBiff8Sst } from '../../../src/readers/xls/sst.js';

const SST = 0x00fc;
const CONTINUE = 0x003c;

function sst(count: number, unique: number, strings: Uint8Array): Uint8Array {
  const data = new Uint8Array(8 + strings.length);
  const view = new DataView(data.buffer);
  view.setInt32(0, count, true);
  view.setInt32(4, unique, true);
  data.set(strings, 8);
  return data;
}

function unicodeString(value: string, highByte = false): Uint8Array {
  const data = new Uint8Array(3 + value.length * (highByte ? 2 : 1));
  const view = new DataView(data.buffer);
  view.setUint16(0, value.length, true);
  data[2] = highByte ? 1 : 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    data[3 + index * (highByte ? 2 : 1)] = code & 0xff;
    if (highByte) data[4 + index * 2] = code >>> 8;
  }
  return data;
}

describe('BIFF8 shared string table', () => {
  it('decodes low-byte strings as Latin-1 and wide strings as UTF-16LE', () => {
    const strings = new Uint8Array([...unicodeString('café'), ...unicodeString('AΩ😀', true)]);
    expect(readBiff8Sst(sst(2, 2, strings), [], new Budget(resolveLimits()))).toEqual(['café', 'AΩ😀']);
  });

  it('consumes an encoding option byte only when character data continues', () => {
    const base = sst(1, 1, Uint8Array.of(3, 0, 0, 0x41));
    expect(readBiff8Sst(base, [Uint8Array.of(1, 0xa9, 0x03, 0x42, 0)], new Budget(resolveLimits()))).toEqual([
      'AΩB',
    ]);
  });

  it('allows a character continuation to switch from wide to low-byte characters', () => {
    const base = sst(1, 1, Uint8Array.of(3, 0, 1, 0x41, 0));
    expect(readBiff8Sst(base, [Uint8Array.of(0, 0xe9, 0x42)], new Budget(resolveLimits()))).toEqual(['AéB']);
  });

  it('does not consume an option byte when a string header begins in a CONTINUE record', () => {
    const base = sst(1, 1, Uint8Array.of(2));
    expect(readBiff8Sst(base, [Uint8Array.of(0, 0, 0x41, 0x42)], new Budget(resolveLimits()))).toEqual([
      'AB',
    ]);
  });

  it('does not consume an option byte when a new string header starts at a CONTINUE boundary', () => {
    const base = sst(2, 2, Uint8Array.of(1, 0, 0, 0x41));
    expect(readBiff8Sst(base, [Uint8Array.of(1, 0, 0, 0x42)], new Budget(resolveLimits()))).toEqual([
      'A',
      'B',
    ]);
  });

  it.each([0x02, 0x10, 0x80])('rejects reserved XLUnicodeRichExtendedString flag bits %#x', (flags) => {
    expect(() =>
      readBiff8Sst(sst(1, 1, Uint8Array.of(0, 0, flags)), [], new Budget(resolveLimits())),
    ).toThrow(CorruptFileError);
  });

  it.each([0x02, 0x80])('rejects reserved CONTINUE character option bits %#x', (option) => {
    const base = sst(1, 1, Uint8Array.of(1, 0, 0, 0x41));
    expect(() => readBiff8Sst(base, [Uint8Array.of(option, 0x42)], new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
  });

  it('accepts the full unsigned 16-bit cch range without applying Excel cell-entry limits', () => {
    const value = 'A'.repeat(0xffff);
    expect(readBiff8Sst(sst(1, 1, unicodeString(value)), [], new Budget(resolveLimits()))).toEqual([value]);
  });

  it('does not consume an option byte when rich and extended header fields continue', () => {
    const base = sst(1, 1, Uint8Array.of(1, 0, 0x0c, 1));
    const continues = [Uint8Array.of(0, 2, 0, 0, 0, 0x41), Uint8Array.of(1, 0, 2, 0), Uint8Array.of(7, 8)];
    expect(readBiff8Sst(base, continues, new Budget(resolveLimits()))).toEqual(['A']);
  });

  it('does not consume an option byte at rich-run or extended-data continuation boundaries', () => {
    const base = sst(1, 1, Uint8Array.of(1, 0, 0x0c, 1, 0, 3, 0, 0, 0, 0x41));
    const continues = [Uint8Array.of(1, 0), Uint8Array.of(2, 0, 7), Uint8Array.of(8, 9)];
    expect(readBiff8Sst(base, continues, new Budget(resolveLimits()))).toEqual(['A']);
  });

  it('rejects truncated headers, character bytes, rich runs, and extended data with generic errors', () => {
    const budget = new Budget(resolveLimits());
    expect(() => readBiff8Sst(Uint8Array.of(1), [], budget)).toThrow(CorruptFileError);
    expect(() => readBiff8Sst(sst(1, 1, Uint8Array.of(2, 0, 0, 0x41)), [], budget)).toThrow(CorruptFileError);
    expect(() => readBiff8Sst(sst(1, 1, Uint8Array.of(1, 0, 8, 1, 0, 0x41)), [], budget)).toThrow(
      CorruptFileError,
    );
    expect(() => readBiff8Sst(sst(1, 1, Uint8Array.of(1, 0, 4, 2, 0, 0, 0, 0x41)), [], budget)).toThrow(
      CorruptFileError,
    );
  });

  it('rejects inconsistent and lying SST counts without using them for allocation', () => {
    expect(() => readBiff8Sst(sst(0, 1, new Uint8Array()), [], new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
    expect(() => readBiff8Sst(sst(1, 1, new Uint8Array()), [], new Budget(resolveLimits()))).toThrow(
      CorruptFileError,
    );
    expect(() =>
      readBiff8Sst(sst(0x7fffffff, 0x7fffffff, new Uint8Array()), [], new Budget(resolveLimits())),
    ).toThrow(LimitExceededError);
  });

  it('caps total string characters before materializing strings', () => {
    const strings: Uint8Array[] = [];
    for (let index = 0; index < 306; index += 1) {
      const item = new Uint8Array(3 + 0xffff);
      const view = new DataView(item.buffer);
      view.setUint16(0, 0xffff, true);
      item[2] = 0;
      strings.push(item);
    }
    const body = new Uint8Array(strings.reduce((total, item) => total + item.length, 0));
    let offset = 0;
    for (const item of strings) {
      body.set(item, offset);
      offset += item.length;
    }
    expect(() => readBiff8Sst(sst(306, 306, body), [], new Budget(resolveLimits()))).toThrow(
      LimitExceededError,
    );
  });

  it('honors cancellation during SST parsing', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      readBiff8Sst(
        sst(1, 1, unicodeString('a')),
        [],
        new Budget(resolveLimits(), { signal: controller.signal }),
      ),
    ).toThrow(AbortError);
  });

  it('reads the self-authored LibreOffice BIFF8 source and its long continued string', () => {
    const bytes = new Uint8Array(
      readFileSync(fileURLToPath(new URL('./fixtures/biff8-source.xls', import.meta.url))),
    );
    const cfb = openCfb(bytes, new Budget(resolveLimits()));
    const workbook = cfb.read('Workbook');
    const records = [...iterateBiffRecords(workbook, new Budget(resolveLimits()))];
    const sstIndex = records.findIndex((item) => item.id === SST);
    expect(sstIndex).toBeGreaterThanOrEqual(0);
    const continuationBodies: Uint8Array[] = [];
    for (let index = sstIndex + 1; records[index]?.id === CONTINUE; index += 1) {
      continuationBodies.push(records[index]!.data);
    }
    expect(continuationBodies.length).toBeGreaterThan(0);
    const strings = readBiff8Sst(records[sstIndex]!.data, continuationBodies, new Budget(resolveLimits()));
    expect(
      strings.some(
        (value) =>
          value.length === 20_017 &&
          value.startsWith('Continuation Ω 中 ') &&
          value.endsWith('A'.repeat(20_000)),
      ),
    ).toBe(true);
  });
});

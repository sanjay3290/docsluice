import { describe, expect, it } from 'vitest';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  UnsupportedFormatError,
} from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { iterateBiffRecords, MAX_BIFF_RECORDS } from '../../../src/readers/xls/records.js';
import { fuzzBiffRecords } from '../../../fuzz/xls-records.fuzz.js';

const BOF = 0x0809;
const EOF = 0x000a;
const FILEPASS = 0x002f;

function record(id: number, data: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(4 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, id, true);
  view.setUint16(2, data.length, true);
  bytes.set(data, 4);
  return bytes;
}

function stream(...records: Uint8Array[]): Uint8Array {
  const size = records.reduce((total, item) => total + item.length, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const item of records) {
    bytes.set(item, offset);
    offset += item.length;
  }
  return bytes;
}

function bof(version = 0x0600): Uint8Array {
  const data = new Uint8Array(16);
  new DataView(data.buffer).setUint16(0, version, true);
  new DataView(data.buffer).setUint16(2, 0x0005, true);
  return record(BOF, data);
}

describe('BIFF records', () => {
  it('iterates little-endian record headers and bounded payload views', () => {
    const bytes = stream(bof(), record(0x0200, Uint8Array.of(1, 2, 3)), record(EOF, new Uint8Array()));
    const records = [...iterateBiffRecords(bytes, new Budget(resolveLimits()))];

    expect(records.map(({ id, offset, data }) => [id, offset, [...data]])).toEqual([
      [BOF, 0, [...bof().subarray(4)]],
      [0x0200, 20, [1, 2, 3]],
      [EOF, 27, []],
    ]);
  });

  it('rejects a truncated record header, a truncated payload, and payloads above the BIFF limit', () => {
    expect(() => [...iterateBiffRecords(Uint8Array.of(1, 2, 3), new Budget(resolveLimits()))]).toThrow(
      CorruptFileError,
    );
    expect(() => [
      ...iterateBiffRecords(stream(bof(), Uint8Array.of(1, 2, 3, 0, 1)), new Budget(resolveLimits())),
    ]).toThrow(CorruptFileError);
    expect(() => [
      ...iterateBiffRecords(
        stream(bof(), record(0x0200, new Uint8Array(8_225))),
        new Budget(resolveLimits()),
      ),
    ]).toThrow(CorruptFileError);
  });

  it('requires a BIFF8 BOF and rejects older BIFF explicitly', () => {
    expect(() => [...iterateBiffRecords(record(EOF, new Uint8Array()), new Budget(resolveLimits()))]).toThrow(
      CorruptFileError,
    );
    expect(() => [...iterateBiffRecords(stream(bof(0x0500)), new Budget(resolveLimits()))]).toThrow(
      UnsupportedFormatError,
    );
    const oldBudget = new Budget(resolveLimits());
    expect(() => [...iterateBiffRecords(stream(bof(0x0500)), oldBudget)]).toThrow(UnsupportedFormatError);
    expect(oldBudget.warnings.warnings).toEqual([
      { code: 'UNREADABLE_PART', message: 'BIFF5 and older XLS workbooks are unsupported.' },
    ]);
    expect(() => [
      ...iterateBiffRecords(
        stream(record(BOF, Uint8Array.of(0, 6)), record(EOF, new Uint8Array())),
        new Budget(resolveLimits()),
      ),
    ]).toThrow(CorruptFileError);
  });

  it('detects FILEPASS as encrypted without reading the payload', () => {
    expect(() => [
      ...iterateBiffRecords(
        stream(bof(), record(FILEPASS, Uint8Array.of(0, 0))),
        new Budget(resolveLimits()),
      ),
    ]).toThrow(EncryptedError);
  });

  it('ticks the shared budget before reading malformed input', () => {
    const controller = new AbortController();
    controller.abort();
    const budget = new Budget(resolveLimits(), { signal: controller.signal });
    expect(() => [...iterateBiffRecords(new Uint8Array(), budget)]).toThrow(AbortError);
  });

  it('caps yielded records before exposing a record beyond the limit', () => {
    const bytes = new Uint8Array(20 + MAX_BIFF_RECORDS * 4);
    bytes.set(bof());
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < MAX_BIFF_RECORDS; index += 1) {
      const offset = 20 + index * 4;
      view.setUint16(offset, 0x7777, true);
      view.setUint16(offset + 2, 0, true);
    }
    const iterator = iterateBiffRecords(bytes, new Budget(resolveLimits()));
    let yielded = 0;
    expect(() => {
      for (const item of iterator) {
        void item;
        yielded += 1;
      }
    }).toThrow(LimitExceededError);
    expect(yielded).toBe(MAX_BIFF_RECORDS);
  });

  it('survives arbitrary malformed bytes through the bounded fuzz entry point', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const bytes = new Uint8Array(128);
      let state = seed + 1;
      for (let index = 0; index < bytes.length; index += 1) {
        state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
        bytes[index] = state & 0xff;
      }
      expect(() => fuzzBiffRecords(bytes)).not.toThrow();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { createNullProtoRecord } from '../../src/core/safe.js';

describe('null-prototype file-data records', () => {
  it('keeps hostile keys as own data without altering prototypes', () => {
    const before = Reflect.ownKeys(Object.prototype);
    const record = createNullProtoRecord<Record<string, string>>();
    for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) record[key] = key;
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.keys(record)).toEqual(['__proto__', 'constructor', 'prototype', 'toString']);
    const hostileKey = '__proto__';
    expect(record[hostileKey]).toBe(hostileKey);
    expect(Reflect.ownKeys(Object.prototype)).toEqual(before);
  });

  it('creates independent empty records', () => {
    const first = createNullProtoRecord();
    const second = createNullProtoRecord();
    first['key'] = 'value';
    expect(Object.keys(second)).toEqual([]);
  });
});

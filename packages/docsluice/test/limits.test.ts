import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, resolveLimits } from '../src/index.js';

describe('limits', () => {
  it('matches the PRD section 14.2 defaults', () => {
    expect(DEFAULT_LIMITS).toMatchObject({
      inputBytes: 100_000_000,
      totalUncompressedBytes: 500_000_000,
      compressionRatio: 100,
      compressionRatioMinBytes: 1_000_000,
      zipEntries: 10_000,
      childDepth: 3,
      xmlDepth: 256,
      outputChars: 20_000_000,
      cells: 2_000_000,
      pdfPages: 2_000,
      timeMs: 60_000,
    });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });

  it('merges overrides and ignores unknown keys', () => {
    const hostile = JSON.parse('{"timeMs": 15000, "__proto__": {"polluted": true}}') as Record<
      string,
      unknown
    >;
    const limits = resolveLimits(hostile);
    expect(limits.timeMs).toBe(15_000);
    expect(limits.inputBytes).toBe(DEFAULT_LIMITS.inputBytes);
    expect(Object.getPrototypeOf(limits)).toBe(Object.prototype);
  });

  it('rejects negative and non-finite values', () => {
    expect(() => resolveLimits({ zipEntries: -1 })).toThrow(RangeError);
    expect(() => resolveLimits({ timeMs: Number.NaN })).toThrow(RangeError);
  });
});

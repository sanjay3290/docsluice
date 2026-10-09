import { afterEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { WarningSink } from '../../src/core/warnings.js';
import {
  resolveLimits,
  StrictModeError,
  AbortError,
  TimeoutError,
  LimitExceededError,
} from '../../src/index.js';

afterEach(() => vi.restoreAllMocks());

describe('Budget', () => {
  it('exposes counted resources without writable counters', () => {
    const budget = new Budget(resolveLimits());
    expect(budget.inputBytes).toBe(0);
    expect(budget.entries).toBe(0);
    expect(budget.pages).toBe(0);
    expect(budget.outputChars).toBe(0);
    budget.addInputBytes(2);
    budget.addEntries(3);
    budget.addPages(4);
    budget.addOutputChars(5);
    const child = budget.child();
    expect(child.inputBytes).toBe(2);
    expect(child.signal).toBeUndefined();
    expect(Object.isFrozen(child.limits)).toBe(true);
    expect(child.limits).toBe(budget.limits);
    expect(child.entries).toBe(3);
    expect(child.pages).toBe(4);
    expect(child.outputChars).toBe(5);
    expect(() => Reflect.set(child, 'inputBytes', 0)).not.toThrow();
    expect(child.inputBytes).toBe(2);
  });

  const counters = [
    ['inputBytes', 'addInputBytes'],
    ['totalUncompressedBytes', 'addUncompressed'],
    ['zipEntries', 'addEntries'],
    ['cells', 'addCells'],
    ['outputChars', 'addOutputChars'],
    ['pdfPages', 'addPages'],
  ] as const;

  it.each(counters)('enforces %s in throw mode at the exact boundary', (limit, method) => {
    const budget = new Budget(resolveLimits({ [limit]: 2 }), { onLimit: 'throw' });
    expect(budget[method](2)).toBe(true);
    expect(() => budget[method](1)).toThrow(new LimitExceededError(limit, 2));
  });

  it.each(counters.slice(1))('truncates %s once, with structure-only counts', (limit, method) => {
    const budget = new Budget(resolveLimits({ [limit]: 2 }));
    expect(budget[method](2)).toBe(true);
    expect(budget[method](1)).toBe(false);
    expect(budget[method](1)).toBe(false);
    expect(budget.truncated).toBe(true);
    expect(budget.warnings.warnings).toHaveLength(1);
    expect(budget.warnings.warnings[0]).toMatchObject({ code: 'TRUNCATED' });
    expect(budget.warnings.warnings[0]?.message).toContain(limit);
    expect(budget.warnings.warnings[0]?.message).toContain('2');
    expect(budget.warnings.warnings[0]?.message).toContain('3');
  });

  it('always throws on input size, including truncate mode', () => {
    const budget = new Budget(resolveLimits({ inputBytes: 0 }));
    expect(() => budget.addInputBytes(1)).toThrow(LimitExceededError);
  });

  it('preflights staged output without charging characters twice', () => {
    const budget = new Budget(resolveLimits({ outputChars: 5 }));
    budget.addOutputChars(2);
    const child = budget.child();
    expect(child.checkOutputChars(3)).toBe(true);
    expect(budget.outputChars).toBe(2);
    expect(child.checkOutputChars(4)).toBe(false);
    expect(budget.outputChars).toBe(2);
    expect(budget.truncated).toBe(true);
    expect(budget.warnings.warnings).toHaveLength(1);
    expect(() => child.checkOutputChars(-1)).toThrow(RangeError);
    const throwing = new Budget(resolveLimits({ outputChars: 0 }), { onLimit: 'throw' });
    expect(() => throwing.checkOutputChars(1)).toThrow(LimitExceededError);
    const blocked = new Budget(resolveLimits({ childDepth: 0 })).child();
    expect(blocked.checkOutputChars(0)).toBe(false);
  });

  it('uses one allowance for parent, children and siblings', () => {
    const budget = new Budget(resolveLimits({ totalUncompressedBytes: 10 }));
    expect(budget.addUncompressed(7)).toBe(true);
    const child = budget.child();
    expect(child.depth).toBe(1);
    expect(child.addUncompressed(3)).toBe(true);
    expect(budget.child().addUncompressed(1)).toBe(false);
    expect(budget.truncated).toBe(true);
    expect(child.truncated).toBe(true);
    expect(child.warnings).toBe(budget.warnings);
    expect(child.totalUncompressedBytes).toBe(11);
    expect(child.child().depth).toBe(2);
  });

  it('does not reset the clock or abort signal when creating children', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const signal = new AbortController();
    const budget = new Budget(resolveLimits({ timeMs: 5 }), { signal: signal.signal });
    expect(budget.signal).toBe(signal.signal);
    expect(budget.child().signal).toBe(signal.signal);
    clock.mockReturnValue(6);
    expect(() => budget.child().tick()).toThrow(TimeoutError);
    signal.abort('caller reason');
    try {
      budget.child().tick();
    } catch (error) {
      expect(error).toBeInstanceOf(AbortError);
      expect((error as Error).cause).toBe('caller reason');
      return;
    }
    throw new Error('Expected cancellation');
  });

  it('checks abort on every tick while sampling the clock at most once per 1024 ticks', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const signal = new AbortController();
    const budget = new Budget(resolveLimits({ timeMs: 1 }), { signal: signal.signal });
    budget.tick();
    const reads = clock.mock.calls.length;
    clock.mockReturnValue(2);
    for (let i = 0; i < 1023; i++) budget.tick();
    expect(clock.mock.calls.length).toBe(reads);
    expect(() => budget.tick()).toThrow(TimeoutError);
    signal.abort();
    expect(() => budget.tick()).toThrow(AbortError);
  });

  it('accepts the exact time boundary and throws after it', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const budget = new Budget(resolveLimits({ timeMs: 5 }));
    clock.mockReturnValue(5);
    expect(() => budget.tick()).not.toThrow();
    clock.mockReturnValue(6);
    for (let i = 0; i < 1023; i++) budget.tick();
    expect(() => budget.tick()).toThrow(new TimeoutError(5));
  });

  it('applies the hard compression ratio only above its threshold', () => {
    const budget = new Budget(resolveLimits({ compressionRatio: 2, compressionRatioMinBytes: 10 }));
    expect(budget.checkRatio(1, 10)).toBe(true);
    expect(budget.checkRatio(6, 12)).toBe(true);
    expect(() => budget.checkRatio(5, 11)).toThrow(new LimitExceededError('compressionRatio', 2));
    expect(budget.checkRatio(0, 0)).toBe(true);
    expect(() => budget.checkRatio(0, 11)).toThrow(LimitExceededError);
  });

  it.each(['xml', 'block'] as const)('checks and balances %s depth', (kind) => {
    const limit = kind === 'xml' ? 'xmlDepth' : 'blockDepth';
    const budget = new Budget(resolveLimits({ [limit]: 1 }));
    expect(budget.enterDepth(kind)).toBe(true);
    expect(budget.enterDepth(kind)).toBe(false);
    budget.exitDepth(kind);
    budget.exitDepth(kind);
    budget.exitDepth(kind);
    expect(budget.enterDepth(kind)).toBe(true);
    const throwing = new Budget(resolveLimits({ [limit]: 0 }), { onLimit: 'throw' });
    expect(() => throwing.enterDepth(kind)).toThrow(new LimitExceededError(limit, 0));
  });

  it('lists children beyond childDepth and prevents their work even in throw mode', () => {
    const budget = new Budget(resolveLimits({ childDepth: 1 }), { onLimit: 'throw' });
    const child = budget.child();
    const blocked = child.child();
    expect(blocked.depth).toBe(2);
    expect(blocked.canRead).toBe(false);
    expect(blocked.addUncompressed(1)).toBe(false);
    expect(budget.totalUncompressedBytes).toBe(0);
    expect(budget.warnings.warnings).toHaveLength(1);
    expect(budget.warnings.warnings[0]?.code).toBe('DEPTH_LIMIT');
    expect(child.enterDepth('child')).toBe(false);
    child.exitDepth('child');
    child.exitDepth('child');
    expect(child.depth).toBe(1);
  });

  it('guards the counters from invalid increments and caller limit mutation', () => {
    const limits = resolveLimits({ cells: 2 });
    const budget = new Budget(limits);
    limits.cells = 999;
    expect(budget.limits.cells).toBe(2);
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(() => budget.addCells(value)).toThrow(RangeError);
    }
    expect(() => budget.checkRatio(-1, 0)).toThrow(RangeError);
    expect(() => budget.checkRatio(1, -1)).toThrow(RangeError);
    expect(budget.addCells(0)).toBe(true);
    expect(budget.addCells(3)).toBe(false);
    expect(budget.cells).toBe(3);
  });

  it('routes truncation through strict warning handling', () => {
    const warnings = new WarningSink({ strict: ['TRUNCATED'] });
    const budget = new Budget(resolveLimits({ cells: 0 }), { warnings });
    expect(() => budget.addCells(1)).toThrow(StrictModeError);
    expect(budget.truncated).toBe(true);
  });
});

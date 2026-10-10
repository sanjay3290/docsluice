import { AbortError, LimitExceededError, TimeoutError } from './errors.js';
import { ALWAYS_THROW_LIMITS, resolveLimits } from './limits.js';
import type { Limits } from './limits.js';
import { WarningSink } from './warnings.js';

type Counter = 'inputBytes' | 'totalUncompressedBytes' | 'zipEntries' | 'cells' | 'outputChars' | 'pdfPages';
export type DepthKind = 'xml' | 'block' | 'child';

export interface BudgetOptions {
  onLimit?: 'truncate' | 'throw';
  signal?: AbortSignal;
  warnings?: WarningSink;
}

interface SharedState {
  limits: Readonly<Limits>;
  maxima: ReadonlyMap<keyof Limits, number>;
  onLimit: 'truncate' | 'throw';
  signal?: AbortSignal;
  warnings: WarningSink;
  counters: Map<Counter, number>;
  warned: Set<keyof Limits>;
  truncated: boolean;
  startedAt: number;
  ticks: number;
  /** Set by the signal's `abort` event, so `tick()` reads a field rather than the `aborted` getter. */
  aborted: boolean;
  /** A signal-like object without `addEventListener` is polled instead. */
  pollSignal: boolean;
}

const CLOCK_INTERVAL = 1024;
const warningContexts = new WeakMap<Budget, WarningSink>();

/** Internal pipeline hook; the shared counters retain a document-scoped warning destination. */
export function setBudgetWarnings(budget: Budget, warnings: WarningSink): void {
  warningContexts.set(budget, warnings);
}

/** One extraction's limits and counters; child instances share all resource allowances. */
export class Budget {
  #state: SharedState;
  readonly #depths = new Map<DepthKind, number>();
  #baseDepth = 0;

  constructor(limits: Limits, options: BudgetOptions = {}) {
    const resolved = Object.freeze(resolveLimits(limits));
    this.#state = {
      limits: resolved,
      maxima: new Map(Object.entries(resolved) as Array<[keyof Limits, number]>),
      onLimit: options.onLimit ?? 'truncate',
      signal: options.signal,
      warnings: options.warnings ?? new WarningSink(),
      counters: new Map(),
      warned: new Set(),
      truncated: false,
      startedAt: performance.now(),
      ticks: 0,
      aborted: options.signal?.aborted === true,
      pollSignal: false,
    };
    const signal = options.signal;
    if (signal && !this.#state.aborted) {
      if (typeof signal.addEventListener === 'function') {
        const state = this.#state;
        signal.addEventListener('abort', () => (state.aborted = true), { once: true });
      } else this.#state.pollSignal = true;
    }
  }

  get depth(): number {
    return this.#depths.get('child') ?? this.#baseDepth;
  }
  get canRead(): boolean {
    return this.depth <= this.#state.limits.childDepth;
  }
  get truncated(): boolean {
    return this.#state.truncated;
  }
  get warnings(): WarningSink {
    return warningContexts.get(this) ?? this.#state.warnings;
  }
  /** The caller signal, exposed read-only so pending stream reads can subscribe to cancellation. */
  get signal(): AbortSignal | undefined {
    return this.#state.signal;
  }
  /** Frozen active limits for readers that can safely flatten or preflight work. */
  get limits(): Readonly<Limits> {
    return this.#state.limits;
  }
  get inputBytes(): number {
    return this.#state.counters.get('inputBytes') ?? 0;
  }
  get totalUncompressedBytes(): number {
    return this.#state.counters.get('totalUncompressedBytes') ?? 0;
  }
  get entries(): number {
    return this.#state.counters.get('zipEntries') ?? 0;
  }
  get cells(): number {
    return this.#state.counters.get('cells') ?? 0;
  }
  get outputChars(): number {
    return this.#state.counters.get('outputChars') ?? 0;
  }
  get pages(): number {
    return this.#state.counters.get('pdfPages') ?? 0;
  }

  /** Create a deeper view without resetting the shared clock, signal or allowance. */
  child(): Budget {
    const child = new Budget(this.#state.limits);
    child.#state = this.#state;
    child.#baseDepth = this.depth + 1;
    setBudgetWarnings(child, this.warnings);
    child.#checkDepth('child', child.depth);
    return child;
  }

  addInputBytes(amount: number): boolean {
    return this.#add('inputBytes', amount);
  }
  addUncompressed(amount: number): boolean {
    return this.#add('totalUncompressedBytes', amount);
  }
  /** Reject an oversized planned archive read without charging untrusted declared sizes. */
  checkUncompressed(amount: number): boolean {
    this.#validateAmount(amount);
    if (!this.canRead) return false;
    return this.#check('totalUncompressedBytes', this.totalUncompressedBytes + amount);
  }
  addEntries(amount: number): boolean {
    return this.#add('zipEntries', amount);
  }
  addCells(amount: number): boolean {
    return this.#add('cells', amount);
  }
  addOutputChars(amount: number): boolean {
    return this.#add('outputChars', amount);
  }
  /** Bound staged parser text without charging it before the builder emits it. */
  checkOutputChars(amount: number): boolean {
    this.#validateAmount(amount);
    if (!this.canRead) return false;
    return this.#check('outputChars', this.outputChars + amount);
  }
  addPages(amount: number): boolean {
    return this.#add('pdfPages', amount);
  }

  #add(counter: Counter, amount: number): boolean {
    this.#validateAmount(amount);
    if (!this.canRead) return false;
    const state = this.#state;
    const count = (state.counters.get(counter) ?? 0) + amount;
    state.counters.set(counter, count);
    return this.#check(counter, count);
  }

  /** Ratio is a hard limit and is checked against real produced bytes. */
  checkRatio(compressed: number, uncompressed: number): boolean {
    this.#validateAmount(compressed);
    this.#validateAmount(uncompressed);
    const state = this.#state;
    if (uncompressed <= state.limits.compressionRatioMinBytes) return true;
    return this.#check(
      'compressionRatio',
      compressed === 0 ? Number.POSITIVE_INFINITY : uncompressed / compressed,
    );
  }

  /** Abort is checked on every call; elapsed time on the first and each 1024th call after it. */
  tick(): void {
    const state = this.#state;
    if (state.aborted || (state.pollSignal && state.signal?.aborted === true))
      throw new AbortError({ cause: state.signal?.reason });
    if (state.ticks++ % CLOCK_INTERVAL === 0 && performance.now() - state.startedAt > state.limits.timeMs) {
      throw new TimeoutError(state.limits.timeMs);
    }
  }

  enterDepth(kind: DepthKind): boolean {
    const depth = (this.#depths.get(kind) ?? (kind === 'child' ? this.#baseDepth : 0)) + 1;
    this.#depths.set(kind, depth);
    return this.#checkDepth(kind, depth);
  }

  /** Balance even a failed enter, without allowing a child to decrease its inherent depth. */
  exitDepth(kind: DepthKind): void {
    const floor = kind === 'child' ? this.#baseDepth : 0;
    this.#depths.set(kind, Math.max(floor, (this.#depths.get(kind) ?? floor) - 1));
  }

  #checkDepth(kind: DepthKind, count: number): boolean {
    const state = this.#state;
    const limit = kind === 'child' ? 'childDepth' : kind === 'xml' ? 'xmlDepth' : 'blockDepth';
    if (kind !== 'child') return this.#check(limit, count);
    if (count <= state.limits.childDepth) return true;
    state.truncated = true;
    this.#warn(limit, count, 'DEPTH_LIMIT');
    return false;
  }

  #check(limit: keyof Limits, count: number): boolean {
    const state = this.#state;
    const maximum = state.maxima.get(limit)!;
    if (count <= maximum) return true;
    if (state.onLimit === 'throw' || ALWAYS_THROW_LIMITS.has(limit)) {
      throw new LimitExceededError(limit, maximum);
    }
    state.truncated = true;
    this.#warn(limit, count, 'TRUNCATED');
    return false;
  }

  #warn(limit: keyof Limits, count: number, code: 'TRUNCATED' | 'DEPTH_LIMIT'): void {
    const state = this.#state;
    if (state.warned.has(limit)) return;
    state.warned.add(limit);
    this.warnings.add({
      code,
      message: `Limit "${limit}" is ${state.maxima.get(limit)!}; observed ${count}. Further work was skipped.`,
    });
  }

  #validateAmount(amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) {
      throw new RangeError('A budget increment must be a nonnegative safe integer.');
    }
  }
}

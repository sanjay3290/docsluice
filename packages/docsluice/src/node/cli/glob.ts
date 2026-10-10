import { lstat, opendir, stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { DEFAULT_LIMITS } from '../../core/limits.js';

type NativeGlob = (pattern: string, options?: { cwd?: string }) => AsyncIterable<string>;

const DEFAULT_MAX_ENTRIES = 50_000;
const DEFAULT_MAX_MATCHES = 1_000;
const DEFAULT_TIME_MS = DEFAULT_LIMITS.timeMs;

/** Internal expansion limits, exposed only by this Node CLI implementation for tests. */
export interface GlobExpansionLimits {
  maxEntries?: number;
  maxMatches?: number;
  timeMs?: number;
}

interface ResolvedGlobLimits {
  maxEntries: number;
  maxMatches: number;
  timeMs: number;
}

function resolveGlobLimits(limits: GlobExpansionLimits): ResolvedGlobLimits {
  const resolved = {
    maxEntries: limits.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxMatches: limits.maxMatches ?? DEFAULT_MAX_MATCHES,
    timeMs: limits.timeMs ?? DEFAULT_TIME_MS,
  };
  if (!Number.isSafeInteger(resolved.maxEntries) || resolved.maxEntries < 1)
    throw new TypeError('Glob maxEntries must be a positive safe integer.');
  if (!Number.isSafeInteger(resolved.maxMatches) || resolved.maxMatches < 1)
    throw new TypeError('Glob maxMatches must be a positive safe integer.');
  if (!Number.isFinite(resolved.timeMs) || resolved.timeMs < 0)
    throw new TypeError('Glob timeMs must be a finite number >= 0.');
  return resolved;
}

class GlobBudget {
  private readonly startedAt = performance.now();
  private entries = 0;
  private states = 0;
  private matchCount = 0;

  constructor(private readonly limits: ResolvedGlobLimits) {}

  checkTime(): void {
    if (this.limits.timeMs === 0 || performance.now() - this.startedAt > this.limits.timeMs)
      throw new Error(`Glob expansion exceeded timeMs (${this.limits.timeMs}).`);
  }

  async wait<T>(operation: Promise<T>): Promise<T> {
    this.checkTime();
    const remaining = this.limits.timeMs - (performance.now() - this.startedAt);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<T>((_resolve, reject) => {
          const checkDeadline = () => {
            const left = this.limits.timeMs - (performance.now() - this.startedAt);
            if (left < 0) reject(new Error(`Glob expansion exceeded timeMs (${this.limits.timeMs}).`));
            else timer = setTimeout(checkDeadline, Math.min(Math.max(1, Math.ceil(left)), 2_147_483_647));
          };
          timer = setTimeout(checkDeadline, Math.min(Math.max(1, Math.ceil(remaining)), 2_147_483_647));
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.checkTime();
    }
  }

  visitEntry(): void {
    this.checkTime();
    this.entries += 1;
    if (this.entries > this.limits.maxEntries)
      throw new Error(`Glob expansion exceeded maxEntries (${this.limits.maxEntries}).`);
  }

  queueState(): void {
    this.checkTime();
    this.states += 1;
    if (this.states > this.limits.maxEntries)
      throw new Error(
        `Glob expansion exceeded maxEntries (${this.limits.maxEntries}) while queuing traversal states.`,
      );
  }

  addMatch(matches: Set<string>, path: string): void {
    this.checkTime();
    if (matches.has(path)) return;
    if (this.matchCount >= this.limits.maxMatches)
      throw new Error(`Glob expansion exceeded maxMatches (${this.limits.maxMatches}).`);
    this.matchCount += 1;
    matches.add(path);
  }
}

/** Expand a filesystem glob with bounded native or fallback traversal. */
export async function expandGlob(
  pattern: string,
  cwd = process.cwd(),
  limits: GlobExpansionLimits = {},
): Promise<string[]> {
  return (await expandGlobs([pattern], cwd, limits))[0]!;
}

/** Expand several patterns under one shared entry, match, and time budget. */
export async function expandGlobs(
  patterns: readonly string[],
  cwd = process.cwd(),
  limits: GlobExpansionLimits = {},
): Promise<string[][]> {
  const budget = new GlobBudget(resolveGlobLimits(limits));
  if (patterns.length === 0) return [];
  const fs = await budget.wait(import('node:fs/promises'));
  const nativeGlob = (fs as typeof fs & { glob?: NativeGlob }).glob;
  const groups: string[][] = [];
  for (const pattern of patterns) {
    budget.checkTime();
    groups.push(
      nativeGlob
        ? await expandNativeGlob(pattern, cwd, nativeGlob, budget)
        : await expandGlobFallbackWithBudget(pattern, cwd, budget),
    );
  }
  return groups;
}

async function expandNativeGlob(
  pattern: string,
  cwd: string,
  nativeGlob: NativeGlob,
  budget: GlobBudget,
): Promise<string[]> {
  const matches = new Set<string>();
  const iterator = nativeGlob(pattern, { cwd })[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const item = await budget.wait(iterator.next());
      if (item.done) {
        completed = true;
        break;
      }
      // Node's native glob yields matched paths rather than all inspected Dirents.
      // The deadline bounds internal traversal; this count bounds its yielded work.
      budget.visitEntry();
      const path = resolve(cwd, item.value);
      if ((await budget.wait(stat(path))).isFile()) budget.addMatch(matches, path);
    }
    return [...matches].sort();
  } finally {
    if (!completed) {
      const closing = iterator.return?.();
      if (closing) void closing.catch(() => undefined);
    }
  }
}

/** Small bounded Node 20 fallback for `*`, `?`, and `**` path-segment globs. */
export async function expandGlobFallback(
  pattern: string,
  cwd = process.cwd(),
  limits: GlobExpansionLimits = {},
): Promise<string[]> {
  return expandGlobFallbackWithBudget(pattern, cwd, new GlobBudget(resolveGlobLimits(limits)));
}

async function expandGlobFallbackWithBudget(
  pattern: string,
  cwd: string,
  budget: GlobBudget,
): Promise<string[]> {
  const absolutePattern = isAbsolute(pattern) ? pattern : resolve(cwd, pattern);
  const root = parse(absolutePattern).root;
  const parts = absolutePattern.slice(root.length).split(/[\\/]/).filter(Boolean);
  const matches = new Set<string>();
  const pending: Array<{ directory: string; part: number }> = [];
  const visited = new Set<string>();
  let base = root;
  let firstWildcard = 0;
  while (firstWildcard < parts.length) {
    const segment = parts[firstWildcard]!;
    if (segment === '**' || hasWildcard(segment)) break;
    const candidate = join(base, segment);
    let info;
    try {
      info = await budget.wait(lstat(candidate));
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    if (info.isSymbolicLink()) return [];
    if (firstWildcard < parts.length - 1 && !info.isDirectory()) return [];
    base = candidate;
    firstWildcard += 1;
  }
  queue({ directory: base, part: firstWildcard });

  while (pending.length > 0) {
    budget.checkTime();
    const state = pending.pop()!;
    const key = `${state.directory}\0${state.part}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (state.part === parts.length) {
      try {
        if ((await budget.wait(stat(state.directory))).isFile()) budget.addMatch(matches, state.directory);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      continue;
    }

    const segment = parts[state.part]!;
    if (segment === '**') {
      queue({ directory: state.directory, part: state.part + 1 });
      for await (const entry of entries(state.directory, budget)) {
        if (entry.isDirectory()) queue({ directory: join(state.directory, entry.name), part: state.part });
      }
      continue;
    }

    if (!hasWildcard(segment)) {
      for await (const entry of entries(state.directory, budget)) {
        if (entry.name !== segment) continue;
        const path = join(state.directory, segment);
        if (state.part + 1 === parts.length) {
          if (entry.isFile()) budget.addMatch(matches, path);
        } else if (entry.isDirectory()) {
          queue({ directory: path, part: state.part + 1 });
        }
        break;
      }
      continue;
    }

    for await (const entry of entries(state.directory, budget)) {
      if (!segmentMatches(segment, entry.name, budget)) continue;
      const path = join(state.directory, entry.name);
      if (state.part + 1 === parts.length) {
        if (entry.isFile()) budget.addMatch(matches, path);
      } else if (entry.isDirectory()) {
        queue({ directory: path, part: state.part + 1 });
      }
    }
  }

  return [...matches].sort();

  function queue(state: { directory: string; part: number }): void {
    budget.queueState();
    pending.push(state);
  }
}

function hasWildcard(segment: string): boolean {
  return segment.includes('*') || segment.includes('?');
}

/** Match one path segment with a bounded iterative glob NFA, never a backtracking regexp. */
function segmentMatches(pattern: string, value: string, budget: GlobBudget): boolean {
  let previous = new Uint8Array(value.length + 1);
  let current = new Uint8Array(value.length + 1);
  previous[0] = 1;
  let operations = 0;

  for (let patternIndex = 0; patternIndex < pattern.length; patternIndex++) {
    budget.checkTime();
    const token = pattern[patternIndex]!;
    if (token === '*') {
      current[0] = previous[0]!;
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++) {
        current[valueIndex] = previous[valueIndex]! | current[valueIndex - 1]!;
        operations++;
        if ((operations & 0xff) === 0) budget.checkTime();
      }
    } else {
      current[0] = 0;
      for (let valueIndex = 1; valueIndex <= value.length; valueIndex++) {
        current[valueIndex] =
          previous[valueIndex - 1] !== 0 && (token === '?' || token === value[valueIndex - 1]) ? 1 : 0;
        operations++;
        if ((operations & 0xff) === 0) budget.checkTime();
      }
    }
    [previous, current] = [current, previous];
  }
  budget.checkTime();
  return previous[value.length] === 1;
}

async function* entries(directory: string, budget: GlobBudget) {
  let handle;
  try {
    let deadlinePassed = false;
    const opening = opendir(directory).then((opened) => {
      if (deadlinePassed) void opened.close().catch(() => undefined);
      return opened;
    });
    try {
      handle = await budget.wait(opening);
    } catch (error) {
      deadlinePassed = true;
      throw error;
    }
    const iterator = handle[Symbol.asyncIterator]();
    while (true) {
      const item = await budget.wait(iterator.next());
      if (item.done) return;
      budget.visitEntry();
      yield item.value;
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export function isGlobPattern(value: string): boolean {
  return value.includes('*') || value.includes('?');
}

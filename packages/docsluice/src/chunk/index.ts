import { Budget } from '../core/budget.js';
import { resolveLimits } from '../core/limits.js';
import type { DocsluiceDocument, Location } from '../core/model.js';
import { pieces } from './pieces.js';
import type { Piece } from './pieces.js';

/** Options for {@link chunk} (CHK-1, CHK-2, CHK-3). */
export interface ChunkOptions {
  /**
   * `section` (default) starts a new chunk at every heading and page, slide or sheet; `page` starts
   * one at every page, slide or sheet only; `size` only cuts where a chunk is full, preferring
   * section and block boundaries.
   */
  strategy?: 'section' | 'page' | 'size';
  /** Largest chunk, measured by `countTokens`. Default 2,000. */
  maxSize?: number;
  /** Text repeated from the end of the previous chunk, measured by `countTokens`. Default 200; at most half of `maxSize`. */
  overlap?: number;
  /** A section shorter than this is merged with the next one instead of becoming its own chunk. Default 0. */
  minSize?: number;
  /** Size of a text, for example in model tokens. Default: its length in UTF-16 code units. */
  countTokens?: (text: string) => number;
}

/** One piece of a document for search or a language model. */
export interface Chunk {
  /** Position in the chunk sequence, from 0. */
  index: number;
  text: string;
  /** Enclosing headings and slide, sheet or part titles, outermost first ("Chapter 2 › Pricing"). */
  headingPath: string[];
  /** Locations of the blocks the chunk's text comes from, in order. */
  locations: Location[];
  /** Length of the leading text repeated from the previous chunk (0 for none). */
  overlap: number;
  /** Set when a table row longer than `maxSize` had to be split at cell boundaries. */
  warnings?: string[];
}

interface Entry {
  piece: Piece;
  size: number;
  separatorSize: number;
  overlap: boolean;
}

const ROW_SPLIT = 'A table row longer than maxSize was split at cell boundaries.';

function option(value: number | undefined, fallback: number, name: string, minimum: number): number {
  const result = value ?? fallback;
  if (!Number.isFinite(result) || result < minimum)
    throw new RangeError(`${name} must be a number of at least ${minimum}.`);
  return Math.floor(result);
}

/**
 * Split a document into chunks for search and language models (CHK-1, CHK-2, CHK-3). The text is the
 * document's `toText` output, cut at the strongest break near the end of each chunk: a section
 * boundary, then a block boundary, a sentence end, a line break (table rows are lines), a word
 * boundary and, last, a hard cut. A table row is only split when it alone is longer than `maxSize`.
 * Chunks are produced lazily; the same document and options always give the same chunks.
 */
export function* chunk(document: DocsluiceDocument, options: ChunkOptions = {}): Generator<Chunk> {
  const maxSize = option(options.maxSize, 2_000, 'maxSize', 1);
  const overlapSize = Math.min(option(options.overlap, 200, 'overlap', 0), Math.floor(maxSize / 2));
  const minSize = option(options.minSize, 0, 'minSize', 0);
  const strategy = options.strategy ?? 'section';
  if (strategy !== 'section' && strategy !== 'page' && strategy !== 'size') {
    throw new RangeError('strategy must be "section", "page" or "size".');
  }
  const countTokens = options.countTokens;
  const count = countTokens
    ? (text: string): number => countTokens(text)
    : (text: string): number => text.length;
  const budget = new Budget(resolveLimits());

  let index = 0;
  let current: Entry[] = [];
  let total = 0;

  const totalOf = (entries: readonly Entry[]): number => {
    let sum = 0;
    for (let position = 0; position < entries.length; position++) {
      budget.tick();
      sum += entries[position]!.size + (position > 0 ? entries[position]!.separatorSize : 0);
    }
    return sum;
  };
  const hasContent = (entries: readonly Entry[]): boolean => entries.some((entry) => !entry.overlap);

  const textOf = (entries: readonly Entry[]): string => {
    let text = '';
    for (let position = 0; position < entries.length; position++) {
      budget.tick();
      if (position > 0) text += entries[position]!.piece.separator;
      text += entries[position]!.piece.text;
    }
    return text;
  };

  const build = (entries: readonly Entry[]): Chunk => {
    const text = textOf(entries);
    const locations: Location[] = [];
    const seen = new Set<Location>();
    let headingPath: readonly string[] | undefined;
    let fallbackPath: readonly string[] | undefined;
    let splitRow = false;
    // The overlap is the text before the first piece that is not repeated, with its separator.
    let overlap = 0;
    let offset = 0;
    let counting = true;
    for (let position = 0; position < entries.length; position++) {
      budget.tick();
      const { piece, overlap: repeated } = entries[position]!;
      if (position > 0) offset += piece.separator.length;
      if (counting && !repeated) {
        overlap = position > 0 ? offset : 0;
        counting = false;
      }
      offset += piece.text.length;
      if (!seen.has(piece.loc)) {
        seen.add(piece.loc);
        const copy: Location = { ...piece.loc };
        if (piece.loc.offset) copy.offset = [piece.loc.offset[0], piece.loc.offset[1]];
        locations.push(copy);
      }
      if (!repeated) {
        fallbackPath ??= piece.path;
        if (!piece.heading) headingPath ??= piece.path;
      }
      if (piece.splitRow) splitRow = true;
    }
    const result: Chunk = {
      index: index++,
      text,
      headingPath: [...(headingPath ?? fallbackPath ?? [])],
      locations,
      overlap,
    };
    if (splitRow) result.warnings = [ROW_SPLIT];
    return result;
  };

  /** Trailing whole pieces of an emitted chunk that fit the overlap allowance, marked as repeated. */
  const overlapFrom = (emitted: readonly Entry[], carry: readonly Entry[]): Entry[] => {
    const carrySize = totalOf(carry);
    let allowance = Math.min(overlapSize, maxSize - carrySize - (carry[0]?.separatorSize ?? 0));
    const taken: Entry[] = [];
    for (let position = emitted.length - 1; position >= 0 && allowance > 0; position--) {
      budget.tick();
      const entry = emitted[position]!;
      const cost = entry.size + (taken.length > 0 ? taken[0]!.separatorSize : 0);
      if (cost > allowance) break;
      allowance -= cost;
      taken.unshift({ ...entry, overlap: true });
    }
    return taken;
  };

  /** Where to cut `entries`: the strongest break, preferring a full-enough first part, latest on ties. */
  const cutPoint = (entries: readonly Entry[], incoming: Entry): number => {
    const firstContent = entries.findIndex((entry) => !entry.overlap);
    let best = entries.length;
    let bestStrength = -1;
    let bestFull = false;
    let prefix = 0;
    for (let position = 0; position < entries.length; position++) {
      budget.tick();
      prefix += entries[position]!.size + (position > 0 ? entries[position]!.separatorSize : 0);
      const cut = position + 1;
      if (cut <= firstContent) continue;
      const strength = cut < entries.length ? entries[cut]!.piece.strength : incoming.piece.strength;
      const full = prefix * 2 >= maxSize;
      if (
        (full && !bestFull) ||
        (full === bestFull && (strength > bestStrength || (strength === bestStrength && cut > best)))
      ) {
        best = cut;
        bestStrength = strength;
        bestFull = full;
      }
    }
    return best;
  };

  /** Emit `entries`, moving trailing pieces back while a non-additive counter says the text is too long. */
  function* emit(entries: Entry[]): Generator<Chunk, Entry[]> {
    const kept = [...entries];
    const back: Entry[] = [];
    while (kept.length > 1 && hasContent(kept.slice(0, -1)) && count(textOf(kept)) > maxSize) {
      budget.tick();
      back.unshift(kept.pop()!);
    }
    yield build(kept);
    return back;
  }

  for (const piece of pieces(document, { strategy, maxSize, count, budget })) {
    budget.tick();
    const entry: Entry = {
      piece,
      size: count(piece.text),
      separatorSize: count(piece.separator),
      overlap: false,
    };
    if (piece.forced && current.some((item) => !item.overlap && !item.piece.heading)) {
      let content = 0;
      for (const item of current) {
        budget.tick();
        if (!item.overlap) content += item.size;
      }
      if (content >= minSize) {
        const back = yield* emit(current);
        current = back.map((item) => ({ ...item, overlap: false }));
        total = totalOf(current);
      }
    }
    for (;;) {
      budget.tick();
      const added = current.length > 0 ? entry.separatorSize + entry.size : entry.size;
      if (total + added <= maxSize) {
        current.push(entry);
        total += added;
        break;
      }
      if (!hasContent(current)) {
        current = [];
        total = 0;
        continue;
      }
      const cut = cutPoint(current, entry);
      const emitted = current.slice(0, cut);
      const back = yield* emit(emitted);
      const carry = [...back, ...current.slice(cut)];
      current = [...overlapFrom(emitted.slice(0, emitted.length - back.length), carry), ...carry];
      total = totalOf(current);
    }
  }
  while (hasContent(current)) {
    budget.tick();
    const back = yield* emit(current);
    current = back;
  }
}

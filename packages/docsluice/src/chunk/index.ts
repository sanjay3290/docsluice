import type { Block, DocsluiceDocument, Location, SectionBlock, TableBlock } from '../core/model.js';
import { Budget } from '../core/budget.js';
import { resolveLimits } from '../core/limits.js';

export type ChunkStrategy = 'section' | 'page' | 'size';

export interface ChunkOptions {
  /** Where to prefer chunk boundaries. Defaults to `section`. */
  strategy?: ChunkStrategy;
  /** Maximum value returned by `countTokens` for each chunk. Defaults to 2,000. */
  maxSize?: number;
  /** Number of tokens from the prior chunk to repeat. Defaults to 200. */
  overlap?: number;
  /** Merge a final small chunk into the prior chunk when the size cap permits. Defaults to 0. */
  minSize?: number;
  /** Measure text size. Defaults to JavaScript UTF-16 string length, matching the renderer's character count. */
  countTokens?: (text: string) => number;
}

export interface ChunkWarning {
  code: 'CHUNK_ROW_SPLIT';
  message: string;
}

export interface Chunk {
  text: string;
  headingPath: string[];
  locations: Location[];
  index: number;
  /** Present when a table row larger than the configured limit had to be split. */
  warnings?: ChunkWarning[];
}

interface ChunkState {
  text: string;
  headingPath: string[];
  locations: Location[];
  warnings: ChunkWarning[];
  spans: Array<{ start: number; end: number; location?: Location }>;
  overlapLength?: number;
}

interface Heading {
  level: number;
  text: string;
}

type ChunkLayoutEvent =
  | { type: 'start-section'; block: SectionBlock }
  | { type: 'end-section'; block: SectionBlock }
  | { type: 'text'; text: string; block?: Block; offset: number }
  | { type: 'table-row'; block: TableBlock; cells: string[]; text: string; offset: number; prefix: string };

const DEFAULT_MAX_SIZE = 2_000;
const DEFAULT_OVERLAP = 200;
const ROW_SPLIT_WARNING: ChunkWarning = {
  code: 'CHUNK_ROW_SPLIT',
  message: 'A table row exceeded maxSize and was split at cell boundaries.',
};

/**
 * Lazily split a document's default plain-text rendering into bounded pieces.
 * Traversal uses the same iterative layout and default limits as `toText`, but
 * owns a standalone budget that enforces output, cell, depth, and time limits.
 */
export function* chunk(document: DocsluiceDocument, options: ChunkOptions = {}): Generator<Chunk> {
  const strategy = options.strategy ?? 'section';
  const maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  const overlap = options.overlap ?? Math.min(DEFAULT_OVERLAP, Math.max(0, maxSize - 1));
  const minSize = options.minSize ?? 0;
  const countTokens = options.countTokens ?? ((text: string) => text.length);
  validateOptions(strategy, maxSize, overlap, minSize);

  const budget = new Budget(resolveLimits(), { onLimit: 'throw' });
  const headings: Heading[] = [];
  const sectionTitles: string[] = [];
  const headingScopes: Heading[][] = [];
  let current: ChunkState | undefined;
  let nextIndex = 0;
  let pending: Chunk | undefined;
  const sourceSpans = new WeakMap<Chunk, ChunkState['spans']>();

  const measure = (text: string): number => {
    budget.tick();
    const size = countTokens(text);
    if (!Number.isFinite(size) || size < 0)
      throw new RangeError('countTokens must return a finite number >= 0.');
    return size;
  };
  const path = (): string[] => {
    const result: string[] = [];
    for (const title of sectionTitles) {
      budget.tick();
      result.push(title);
    }
    for (const heading of headings) {
      budget.tick();
      result.push(heading.text);
    }
    return result;
  };
  const makeState = (headingPath: string[] = path()): ChunkState => ({
    text: '',
    headingPath,
    locations: [],
    warnings: [],
    spans: [],
  });
  const addLocation = (
    state: ChunkState,
    block: Block | undefined,
    start: number,
    end: number,
    chunkStart: number,
  ): void => {
    budget.tick();
    let source: Location | undefined;
    if (block) {
      const location = block.loc;
      source = location.offset
        ? { ...location, offset: [location.offset[0] + start, location.offset[0] + end] as [number, number] }
        : { ...location };
      const key = locationKey(source);
      let found = false;
      for (const item of state.locations) {
        budget.tick();
        if (locationKey(item) === key) {
          found = true;
          break;
        }
      }
      if (!found) state.locations.push(source);
    }
    state.spans.push({
      start: chunkStart,
      end: chunkStart + (end - start),
      ...(source ? { location: source } : {}),
    });
  };
  const addWarning = (state: ChunkState): void => {
    if (!state.warnings.some((warning) => warning.code === ROW_SPLIT_WARNING.code)) {
      state.warnings.push({ ...ROW_SPLIT_WARNING });
    }
  };
  const emit = (state: ChunkState): Chunk | undefined => {
    if (state.text.length === 0) return undefined;
    const result: Chunk = {
      text: state.text,
      headingPath: state.headingPath,
      locations: state.locations,
      index: -1,
      ...(state.warnings.length > 0 ? { warnings: state.warnings } : {}),
    };
    sourceSpans.set(result, state.spans);
    return result;
  };
  const release = function* (candidate: Chunk | undefined, allowMerge = true): Generator<Chunk> {
    if (!candidate) return;
    if (
      allowMerge &&
      pending &&
      samePath(pending.headingPath, candidate.headingPath, budget) &&
      minSize > 0 &&
      measure(candidate.text) < minSize
    ) {
      const joined = pending.text + candidate.text;
      if (measure(joined) <= maxSize) {
        const shift = pending.text.length;
        pending.text = joined;
        pending.locations = mergeLocations(pending.locations, candidate.locations, budget);
        pending.warnings = mergeWarnings(pending.warnings ?? [], candidate.warnings ?? []);
        const pendingSpans = sourceSpans.get(pending) ?? [];
        for (const span of sourceSpans.get(candidate) ?? []) {
          budget.tick();
          pendingSpans.push({ ...span, start: span.start + shift, end: span.end + shift });
        }
        sourceSpans.set(pending, pendingSpans);
        return;
      }
    }
    if (pending) {
      pending.index = nextIndex++;
      yield pending;
    }
    candidate.index = -1;
    pending = candidate;
  };
  const append = function* (
    text: string,
    block: Block | undefined,
    blockOffset = 0,
    rowSplit = false,
  ): Generator<Chunk> {
    let rest = text;
    let consumed = 0;
    if (rest.length === 0) return;
    if (!current) current = makeState();
    while (rest.length > 0) {
      budget.tick();
      const fit = largestFittingPrefix(current.text, rest, maxSize, measure, budget);
      if (fit === rest.length) {
        const chunkStart = current.text.length;
        current.text += rest;
        addLocation(current, block, blockOffset + consumed, blockOffset + consumed + rest.length, chunkStart);
        if (rowSplit) addWarning(current);
        return;
      }

      // Prefer a complete block boundary whenever the existing chunk is nonempty.
      if (current.text.length > 0 && consumed === 0 && block) {
        if (current.overlapLength === current.text.length) {
          current = makeState();
          continue;
        }
        const ready = emit(current);
        yield* release(ready);
        current = makeState();
        continue;
      }

      if (fit === 0) {
        if (current.text.length > 0) {
          const ready = emit(current);
          yield* release(ready);
          current = makeState();
          continue;
        }
        const first = firstCodePointLength(rest);
        if (measure(rest.slice(0, first)) > maxSize) {
          throw new RangeError('A single Unicode code point exceeds maxSize under countTokens.');
        }
        const chunkStart = current.text.length;
        current.text += rest.slice(0, first);
        addLocation(current, block, blockOffset + consumed, blockOffset + consumed + first, chunkStart);
        if (rowSplit) addWarning(current);
        rest = rest.slice(first);
        consumed += first;
        const ready = emit(current);
        yield* release(ready, false);
        current = makeState();
        continue;
      }

      const piece = rest.slice(0, fit);
      const chunkStart = current.text.length;
      current.text += piece;
      addLocation(current, block, blockOffset + consumed, blockOffset + consumed + fit, chunkStart);
      if (rowSplit) addWarning(current);
      const ready = emit(current);
      yield* release(ready);
      rest = rest.slice(fit);
      consumed += fit;
      const prefix = overlapTail(ready?.text ?? '', overlap, measure, budget);
      current = makeState();
      if (prefix.text.length > 0 && ready) {
        current.text = prefix.text;
        current.overlapLength = prefix.text.length;
        copyOverlap(ready, current, prefix.start, budget, sourceSpans);
      }
    }
  };

  for (const event of chunkLayout(document, budget)) {
    budget.tick();
    if (event.type === 'start-section') {
      const section = event.block;
      const isPage = section.role === 'page' || section.role === 'slide' || section.role === 'sheet';
      if (
        (strategy === 'page' && isPage) ||
        (strategy === 'section' && (section.role === 'slide' || section.role === 'sheet'))
      ) {
        const ready = current && emit(current);
        yield* release(ready, false);
        current = undefined;
      }
      if (section.role === 'slide' || section.role === 'sheet') {
        headingScopes.push([...headings]);
        headings.length = 0;
        if (section.title) sectionTitles.push(section.title);
      }
      continue;
    }
    if (event.type === 'end-section') {
      const section = event.block;
      if (section.role === 'slide' || section.role === 'sheet') {
        if (strategy === 'section') {
          const ready = current && emit(current);
          yield* release(ready, false);
          current = undefined;
        }
        if (section.title) sectionTitles.pop();
        headings.splice(0, headings.length, ...(headingScopes.pop() ?? []));
      }
      continue;
    }

    if (event.type === 'table-row') {
      if (event.prefix) yield* append(event.prefix, undefined);
      const rowSize = measure(event.text);
      if (rowSize <= maxSize) {
        yield* append(event.text, event.block, event.offset + event.prefix.length);
      } else {
        let cellOffset = event.offset + event.prefix.length;
        for (let cellIndex = 0; cellIndex < event.cells.length; cellIndex++) {
          const cell = event.cells[cellIndex]!;
          const separator = cellIndex === 0 ? '' : '\t';
          yield* append(separator + cell, event.block, cellOffset, true);
          cellOffset += separator.length + cell.length;
        }
      }
      continue;
    }

    const block = event.block;
    if (block?.kind === 'heading') {
      if (strategy === 'section') {
        const ready = current && emit(current);
        yield* release(ready, false);
        current = undefined;
      }
      while (headings.length > 0 && headings[headings.length - 1]!.level >= block.level) headings.pop();
      headings.push({ level: block.level, text: block.text });
      if (current && current.text.length === 0) current.headingPath = path();
    }

    yield* append(event.text, block, event.offset);
  }

  if (current && current.text.length > 0) {
    const ready = emit(current);
    yield* release(ready);
  }
  if (pending) {
    pending.index = nextIndex++;
    yield pending;
  }
}

function validateOptions(strategy: ChunkStrategy, maxSize: number, overlap: number, minSize: number): void {
  if (strategy !== 'section' && strategy !== 'page' && strategy !== 'size') {
    throw new RangeError('strategy must be "section", "page", or "size".');
  }
  if (!Number.isFinite(maxSize) || maxSize <= 0) throw new RangeError('maxSize must be finite and > 0.');
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= maxSize) {
    throw new RangeError('overlap must be finite, >= 0, and less than maxSize.');
  }
  if (!Number.isFinite(minSize) || minSize < 0 || minSize > maxSize) {
    throw new RangeError('minSize must be finite and between 0 and maxSize.');
  }
}

function largestFittingPrefix(
  current: string,
  text: string,
  maxSize: number,
  measure: (value: string) => number,
  budget: Budget,
): number {
  // A bounded window avoids rescanning the whole remaining document at every split.
  let windowLength = Math.min(text.length, Math.max(2, Math.ceil(maxSize) * 4));
  while (true) {
    budget.tick();
    // Inspect the original string so a window cannot end between a surrogate pair.
    if (windowLength < text.length && codePointLengthAt(text, windowLength - 1) === 2) windowLength++;
    if (measure(current + text.slice(0, windowLength)) > maxSize) break;
    if (windowLength === text.length) return text.length;
    windowLength = Math.min(text.length, windowLength * 2);
  }
  const boundaries = codePointBoundaries(text.slice(0, windowLength), () => budget.tick());
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const end = boundaries[middle]!;
    if (measure(current + text.slice(0, end)) <= maxSize) low = middle;
    else high = middle - 1;
  }
  if (low === 0) return 0;
  let end = boundaries[low]!;
  // Back off if a custom counter is not monotonic around the binary-search result.
  while (end > 0 && measure(current + text.slice(0, end)) > maxSize) {
    const index = boundaries.indexOf(end);
    end = boundaries[Math.max(0, index - 1)]!;
  }
  const preferred = preferredBreak(text.slice(0, end), budget);
  return preferred > 0 && measure(current + text.slice(0, preferred)) <= maxSize ? preferred : end;
}

function preferredBreak(text: string, budget: Budget): number {
  let sentence = 0;
  let line = 0;
  let word = 0;
  for (let index = 0; index < text.length;) {
    budget.tick();
    const code = text.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    if (code === 10 || code === 13) line = index + width;
    if (code === 32 || code === 9) word = index + width;
    if (code === 0x3002 || code === 0xff01 || code === 0xff1f) sentence = index + width;
    if (code === 46 || code === 33 || code === 63) {
      let next = index + width;
      while (next < text.length && (text.charCodeAt(next) === 32 || text.charCodeAt(next) === 9)) {
        budget.tick();
        next++;
      }
      const following = text.codePointAt(next);
      if (following !== undefined && /\p{Lu}/u.test(String.fromCodePoint(following))) sentence = next;
    }
    index += width;
  }
  return sentence || line || word;
}

function codePointBoundaries(text: string, tick: () => void = () => undefined): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length;) {
    tick();
    index += codePointLengthAt(text, index);
    offsets.push(index);
  }
  return offsets;
}

function firstCodePointLength(text: string): number {
  const first = text.charCodeAt(0);
  return first >= 0xd800 && first <= 0xdbff && text.length > 1 ? 2 : 1;
}

function codePointLengthAt(text: string, index: number): number {
  const first = text.charCodeAt(index);
  const second = text.charCodeAt(index + 1);
  return first >= 0xd800 && first <= 0xdbff && second >= 0xdc00 && second <= 0xdfff ? 2 : 1;
}

function* chunkLayout(document: DocsluiceDocument, budget: Budget): Generator<ChunkLayoutEvent> {
  interface Frame {
    blocks: Block[];
    index: number;
    section?: SectionBlock;
    entered: boolean;
  }
  const stack: Frame[] = [{ blocks: document.blocks, index: 0, entered: false }];
  try {
    while (stack.length > 0) {
      budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.blocks.length) {
        stack.pop();
        if (frame.entered) budget.exitDepth('block');
        if (frame.section) yield { type: 'end-section', block: frame.section };
        continue;
      }
      if (frame.index > 0) {
        chargeOutput(budget, 2);
        yield textEvent('\n\n', undefined, 0);
      }
      const block = frame.blocks[frame.index++]!;
      if (block.kind === 'section') {
        enterBlockDepth(budget);
        yield { type: 'start-section', block };
        stack.push({ blocks: block.blocks, index: 0, section: block, entered: true });
        continue;
      }
      if (block.kind === 'table') {
        let offset = 0;
        let index = 0;
        if (block.caption !== undefined) {
          chargeOutput(budget, block.caption.length);
          yield { type: 'table-row', block, cells: [block.caption], text: block.caption, offset, prefix: '' };
          offset += block.caption.length;
          index++;
        }
        for (const row of block.rows) {
          budget.tick();
          const cells: string[] = [];
          const pieces: string[] = [];
          for (const cell of row) {
            budget.tick();
            if (!budget.addCells(1)) throw new RangeError('Rendered table exceeded its cell limit.');
            cells.push(cell.text);
            if (pieces.length > 0) pieces.push('\t');
            pieces.push(cell.text);
          }
          const text = pieces.join('');
          const prefix = index === 0 ? '' : '\n';
          chargeOutput(budget, prefix.length + text.length);
          yield { type: 'table-row', block, cells, text, offset, prefix };
          offset += prefix.length + text.length;
          index++;
        }
        continue;
      }
      if (block.kind === 'list') {
        yield* listTextEvents(block, budget);
        continue;
      }
      let text: string;
      switch (block.kind) {
        case 'heading':
        case 'paragraph':
        case 'code':
        case 'note':
        case 'header':
        case 'footer':
          text = block.text;
          break;
        case 'image':
          text = block.alt ?? '';
          break;
      }
      chargeOutput(budget, text.length);
      yield textEvent(text, block, 0);
    }
  } finally {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.entered) budget.exitDepth('block');
    }
  }
}

function* listTextEvents(
  block: Extract<Block, { kind: 'list' }>,
  budget: Budget,
): Generator<ChunkLayoutEvent> {
  interface ListFrame {
    items: typeof block.items;
    index: number;
    depth: number;
    ordered: boolean;
  }
  const stack: ListFrame[] = [];
  let outputOffset = 0;
  let hasLine = false;
  enterBlockDepth(budget);
  stack.push({ items: block.items, index: 0, depth: 0, ordered: block.ordered });
  try {
    while (stack.length > 0) {
      budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.items.length) {
        stack.pop();
        budget.exitDepth('block');
        continue;
      }
      const itemIndex = frame.index++;
      const item = frame.items[itemIndex]!;
      const fallback = frame.ordered ? `${itemIndex + 1}.` : '•';
      const marker = item.marker ?? fallback;
      const text = `${'  '.repeat(frame.depth)}${marker} ${item.text}`;
      const prefix = hasLine ? '\n' : '';
      chargeOutput(budget, prefix.length + text.length);
      yield textEvent(prefix + text, block, outputOffset);
      outputOffset += prefix.length + text.length;
      hasLine = true;
      if (item.items && item.items.length > 0) {
        enterBlockDepth(budget);
        stack.push({ items: item.items, index: 0, depth: frame.depth + 1, ordered: block.ordered });
      }
    }
  } finally {
    while (stack.length > 0) {
      stack.pop();
      budget.exitDepth('block');
    }
  }
}

function textEvent(text: string, block: Block | undefined, offset: number): ChunkLayoutEvent {
  return block ? { type: 'text', text, block, offset } : { type: 'text', text, offset };
}

function chargeOutput(budget: Budget, amount: number): void {
  if (!budget.addOutputChars(amount)) throw new RangeError('Rendered text exceeded its output limit.');
}

function enterBlockDepth(budget: Budget): void {
  try {
    if (!budget.enterDepth('block')) throw new RangeError('Document block nesting exceeded its limit.');
  } catch (error) {
    budget.exitDepth('block');
    throw error;
  }
}

function locationKey(location: Location): string {
  return [
    location.path ?? '',
    location.page ?? '',
    location.slide ?? '',
    location.sheet ?? '',
    location.range ?? '',
    location.offset?.[0] ?? '',
    location.offset?.[1] ?? '',
    location.pageLabel ?? '',
  ].join('\u0000');
}

function overlapTail(
  text: string,
  overlap: number,
  measure: (text: string) => number,
  budget: Budget,
): { text: string; start: number } {
  if (overlap <= 0 || text.length === 0) return { text: '', start: text.length };
  const boundaries = codePointBoundaries(text, () => budget.tick());
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (measure(text.slice(boundaries[middle])) <= overlap) high = middle;
    else low = middle + 1;
  }
  let start = boundaries[low]!;
  if (start === text.length) return { text: '', start };
  for (const sentenceStart of sentenceStarts(text, budget)) {
    if (sentenceStart >= text.length) continue;
    if (measure(text.slice(sentenceStart)) <= overlap) {
      start = sentenceStart;
      break;
    }
  }
  return { text: text.slice(start), start };
}

function sentenceStarts(text: string, budget: Budget): number[] {
  const starts: number[] = [];
  for (let index = 0; index < text.length;) {
    budget.tick();
    const code = text.codePointAt(index)!;
    const width = code > 0xffff ? 2 : 1;
    if (code === 0x3002 || code === 0xff01 || code === 0xff1f) {
      starts.push(index + width);
    } else if (code === 46 || code === 33 || code === 63) {
      let next = index + width;
      while (next < text.length && (text.charCodeAt(next) === 32 || text.charCodeAt(next) === 9)) {
        budget.tick();
        next++;
      }
      if (next > index + width) starts.push(next);
    }
    index += width;
  }
  return starts;
}

function copyOverlap(
  previous: Chunk,
  target: ChunkState,
  start: number,
  budget: Budget,
  sourceSpans: WeakMap<Chunk, ChunkState['spans']>,
): void {
  for (const span of sourceSpans.get(previous) ?? []) {
    budget.tick();
    const overlapStart = Math.max(start, span.start);
    const overlapEnd = Math.min(previous.text.length, span.end);
    if (overlapStart >= overlapEnd) continue;
    let location: Location | undefined;
    if (span.location) {
      const delta = overlapStart - span.start;
      location = span.location.offset
        ? {
            ...span.location,
            offset: [
              span.location.offset[0] + delta,
              span.location.offset[0] + delta + (overlapEnd - overlapStart),
            ],
          }
        : { ...span.location };
      let found = false;
      for (const item of target.locations) {
        budget.tick();
        if (locationKey(item) === locationKey(location)) {
          found = true;
          break;
        }
      }
      if (!found) target.locations.push(location);
    }
    target.spans.push({
      start: overlapStart - start,
      end: overlapEnd - start,
      ...(location ? { location } : {}),
    });
  }
}

function mergeLocations(first: Location[], second: Location[], budget: Budget): Location[] {
  const result = [...first];
  for (const location of second) {
    budget.tick();
    let found = false;
    for (const item of result) {
      budget.tick();
      if (locationKey(item) === locationKey(location)) {
        found = true;
        break;
      }
    }
    if (!found) result.push(location);
  }
  return result;
}

function mergeWarnings(first: ChunkWarning[], second: ChunkWarning[]): ChunkWarning[] {
  const result = [...first];
  for (const warning of second) {
    if (!result.some((item) => item.code === warning.code)) result.push({ ...warning });
  }
  return result;
}

function samePath(first: string[], second: string[], budget: Budget): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) {
    budget.tick();
    if (first[index] !== second[index]) return false;
  }
  return true;
}

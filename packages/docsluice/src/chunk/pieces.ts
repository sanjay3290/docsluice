import type { Budget } from '../core/budget.js';
import type { Block, DocsluiceDocument, ListItem, Location, SectionBlock } from '../core/model.js';

/** Break strengths, strongest first: a chunk is cut at the strongest nearby break (CHK-1). */
export const SECTION = 5;
export const BLOCK = 4;
export const SENTENCE = 3;
export const LINE = 2;
export const WORD = 1;
export const HARD = 0;

/** The smallest unit the packer moves: text plus the separator and break strength before it. */
export interface Piece {
  text: string;
  /** Text between the previous piece and this one in `toText` output (`\n\n`, `\n`, `\t`, a space). */
  separator: string;
  strength: number;
  /** A strategy boundary: the packer must start a new chunk here (unless the chunk is only headings). */
  forced: boolean;
  heading: boolean;
  /** Set when a table row longer than `maxSize` had to be split. */
  splitRow: boolean;
  path: readonly string[];
  loc: Location;
}

export interface PieceOptions {
  strategy: 'section' | 'page' | 'size';
  maxSize: number;
  count: (text: string) => number;
  budget: Budget;
}

function isUpper(character: string): boolean {
  return character.toUpperCase() === character && character.toLowerCase() !== character;
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0 || code === 0x3000;
}

const CLOSERS = new Set([')', ']', '"', "'", '”', '’', '»', '」', '』']);

/**
 * Split text into segments at sentence ends and line breaks, with the break strength before each
 * segment. A sentence ends at `.`, `!` or `?` (after any closing quotes or brackets) followed by
 * white space and an upper-case letter or a digit, or at `。`, `！`, `？`. A hand-written scanner,
 * linear in the text (no regular expressions, SEC-7).
 */
export function segments(
  text: string,
  budget: Budget,
): Array<{ text: string; separator: string; strength: number }> {
  const result: Array<{ text: string; separator: string; strength: number }> = [];
  let start = 0;
  let index = 0;
  let pending: { separator: string; strength: number } = { separator: '', strength: SENTENCE };
  const push = (end: number, nextStart: number, strength: number): void => {
    if (end > start) result.push({ text: text.slice(start, end), ...pending });
    pending = { separator: text.slice(end, nextStart), strength };
    start = nextStart;
  };
  while (index < text.length) {
    budget.tick();
    const character = text[index]!;
    if (character === '\n') {
      push(index, index + 1, LINE);
      index++;
      continue;
    }
    if (character === '。' || character === '！' || character === '？') {
      let end = index + 1;
      while (end < text.length && CLOSERS.has(text[end]!)) end++;
      let next = end;
      while (next < text.length && isSpace(text.charCodeAt(next)) && text[next] !== '\n') next++;
      if (next < text.length) push(end, next, SENTENCE);
      index = Math.max(index + 1, next);
      continue;
    }
    if (character === '.' || character === '!' || character === '?') {
      let end = index + 1;
      while (end < text.length && CLOSERS.has(text[end]!)) {
        budget.tick();
        end++;
      }
      let next = end;
      while (next < text.length && isSpace(text.charCodeAt(next)) && text[next] !== '\n') {
        budget.tick();
        next++;
      }
      const following = text[next];
      if (
        next > end &&
        following !== undefined &&
        (isUpper(following) || (following >= '0' && following <= '9'))
      ) {
        push(end, next, SENTENCE);
        index = next;
        continue;
      }
    }
    index++;
  }
  if (text.length > start) result.push({ text: text.slice(start), ...pending });
  return result;
}

/** Split an oversized segment at spaces, then by characters (never inside a surrogate pair). */
function smaller(
  text: string,
  options: PieceOptions,
): Array<{ text: string; separator: string; strength: number }> {
  const result: Array<{ text: string; separator: string; strength: number }> = [];
  let start = 0;
  let separator = '';
  for (let index = 0; index <= text.length; index++) {
    options.budget.tick();
    if (index < text.length && text.charCodeAt(index) !== 32) continue;
    if (index > start) result.push({ text: text.slice(start, index), separator, strength: WORD });
    if (index >= text.length) break;
    let next = index;
    while (next < text.length && text.charCodeAt(next) === 32) next++;
    separator = text.slice(index, next);
    start = next;
    index = next - 1;
  }
  const output: Array<{ text: string; separator: string; strength: number }> = [];
  for (const word of result) {
    options.budget.tick();
    if (options.count(word.text) <= options.maxSize) {
      output.push(word);
      continue;
    }
    // Hard cut: the longest prefix that fits, found by binary search over code-unit lengths.
    let rest = word.text;
    let first = true;
    while (rest.length > 0) {
      options.budget.tick();
      let low = 1;
      let high = rest.length;
      while (low < high) {
        options.budget.tick();
        const middle = Math.ceil((low + high) / 2);
        if (options.count(rest.slice(0, middle)) <= options.maxSize) low = middle;
        else high = middle - 1;
      }
      let cut = low;
      const code = rest.charCodeAt(cut - 1);
      if (cut < rest.length && cut > 1 && code >= 0xd800 && code <= 0xdbff) cut--;
      output.push({
        text: rest.slice(0, cut),
        separator: first ? word.separator : '',
        strength: first ? word.strength : HARD,
      });
      rest = rest.slice(cut);
      first = false;
    }
  }
  return output;
}

/** Text pieces that each fit `maxSize`; the first keeps `strength`. */
function textPieces(
  text: string,
  strength: number,
  options: PieceOptions,
): Array<{ text: string; separator: string; strength: number }> {
  const result: Array<{ text: string; separator: string; strength: number }> = [];
  let first = true;
  for (const segment of segments(text, options.budget)) {
    options.budget.tick();
    const parts =
      options.count(segment.text) <= options.maxSize
        ? [segment]
        : smaller(segment.text, options).map((part, index) =>
            index === 0 ? { ...part, separator: segment.separator, strength: segment.strength } : part,
          );
    for (const part of parts) {
      options.budget.tick();
      result.push(first ? { text: part.text, separator: '', strength } : part);
      first = false;
    }
  }
  return result;
}

function listLines(ordered: boolean, items: ListItem[], budget: Budget): string[] {
  const lines: string[] = [];
  const stack: Array<{ items: ListItem[]; index: number; depth: number }> = [{ items, index: 0, depth: 0 }];
  while (stack.length > 0) {
    budget.tick();
    const frame = stack.at(-1)!;
    if (frame.index >= frame.items.length) {
      stack.pop();
      continue;
    }
    const itemIndex = frame.index++;
    const item = frame.items[itemIndex]!;
    const marker = item.marker ?? (ordered ? `${itemIndex + 1}.` : '•');
    lines.push(`${'  '.repeat(frame.depth)}${marker} ${item.text}`);
    if (item.items && item.items.length > 0)
      stack.push({ items: item.items, index: 0, depth: frame.depth + 1 });
  }
  return lines;
}

/**
 * Walk the document's blocks in `toText` order (child documents are not included, as in `toText`)
 * and yield pieces lazily. The heading path holds enclosing headings plus slide, sheet and part
 * titles; a heading that repeats its section's title is not added twice.
 */
export function* pieces(document: DocsluiceDocument, options: PieceOptions): Generator<Piece> {
  const { budget } = options;
  const frames: Array<{ blocks: Block[]; index: number; section?: SectionBlock; pathLength: number }> = [
    { blocks: document.blocks, index: 0, pathLength: 0 },
  ];
  // Heading path entries: level 0 for section titles, 1–6 for headings.
  let path: Array<{ level: number; text: string }> = [];
  let snapshot: readonly string[] = [];
  let pendingSeparator = '';
  let pendingForced = false;
  let pendingSection = true;
  const setPath = (next: Array<{ level: number; text: string }>): void => {
    path = next;
    snapshot = next.map((entry) => entry.text);
  };

  while (frames.length > 0) {
    budget.tick();
    const frame = frames.at(-1)!;
    if (frame.index >= frame.blocks.length) {
      frames.pop();
      if (frame.section) setPath(path.slice(0, frame.pathLength));
      continue;
    }
    if (frame.index > 0) pendingSeparator = '\n\n';
    const block = frame.blocks[frame.index++]!;
    if (block.kind === 'section') {
      frames.push({ blocks: block.blocks, index: 0, section: block, pathLength: path.length });
      if (block.title !== undefined && block.title.length > 0)
        setPath([...path, { level: 0, text: block.title }]);
      pendingSection = true;
      if (options.strategy !== 'size') pendingForced = true;
      continue;
    }
    let strength = pendingSection ? SECTION : BLOCK;
    let heading = false;
    if (block.kind === 'heading') {
      heading = true;
      strength = SECTION;
      const kept = path.filter((entry) => {
        budget.tick();
        return entry.level === 0 || entry.level < block.level;
      });
      const repeatsTitle = kept.at(-1)?.level === 0 && kept.at(-1)?.text === block.text;
      setPath(repeatsTitle ? kept : [...kept, { level: block.level, text: block.text }]);
      if (options.strategy === 'section') pendingForced = true;
    }
    const forced = pendingForced;
    const base = { forced: false, heading, splitRow: false, path: snapshot, loc: block.loc };
    let emitted = false;
    const emit = function* (
      parts: Array<{ text: string; separator: string; strength: number }>,
      splitRow = false,
    ): Generator<Piece> {
      for (const part of parts) {
        budget.tick();
        if (!emitted) {
          yield { ...base, ...part, separator: pendingSeparator, strength, forced, splitRow };
          emitted = true;
        } else {
          yield { ...base, ...part, splitRow };
        }
      }
    };

    switch (block.kind) {
      case 'heading':
      case 'paragraph':
      case 'code':
      case 'note':
      case 'header':
      case 'footer':
        yield* emit(textPieces(block.text, strength, options));
        break;
      case 'image':
        if (block.alt !== undefined) yield* emit(textPieces(block.alt, strength, options));
        break;
      case 'list': {
        const lines = listLines(block.ordered, block.items, budget);
        for (let index = 0; index < lines.length; index++) {
          budget.tick();
          const parts = textPieces(lines[index]!, LINE, options);
          if (index > 0 && parts[0]) parts[0] = { ...parts[0], separator: '\n' };
          yield* emit(parts);
        }
        break;
      }
      case 'table': {
        const rows: string[][] = [];
        if (block.caption !== undefined) rows.push([block.caption]);
        for (const row of block.rows) {
          budget.tick();
          rows.push(row.map((cell) => cell.text));
        }
        for (let index = 0; index < rows.length; index++) {
          budget.tick();
          const cells = rows[index]!;
          const rowText = cells.join('\t');
          const separator = index > 0 ? '\n' : '';
          if (options.count(rowText) <= options.maxSize) {
            yield* emit([{ text: rowText, separator, strength: LINE }]);
            continue;
          }
          // A row longer than maxSize is split at cell boundaries, then inside oversized cells.
          const parts: Array<{ text: string; separator: string; strength: number }> = [];
          for (let cell = 0; cell < cells.length; cell++) {
            budget.tick();
            const cellParts = textPieces(cells[cell]!, WORD, options);
            if (cellParts[0]) cellParts[0] = { ...cellParts[0], separator: cell === 0 ? separator : '\t' };
            if (cell === 0 && cellParts[0]) cellParts[0] = { ...cellParts[0], strength: LINE };
            parts.push(...cellParts);
          }
          yield* emit(parts, true);
        }
        break;
      }
    }
    if (emitted) {
      pendingSection = false;
      pendingForced = false;
      pendingSeparator = '';
    }
  }
}

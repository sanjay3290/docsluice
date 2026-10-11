import type { Budget } from '../../../core/budget.js';

/**
 * Reading order for one PDF page (PDF-2): text items become lines, lines are ordered column by
 * column, and lines become paragraphs. Pure functions over the engine's text items; every loop
 * ticks the budget, the column split walks an explicit stack with a fixed depth bound (SEC-8), and
 * every sort has a total, stable key so the same items give the same order (DET-1).
 */

/** One engine text item in PDF user space. */
export interface LayoutItem {
  text: string;
  /** Baseline origin. */
  x: number;
  y: number;
  /** Advance along the text direction. */
  width: number;
  /** Font size along the text's up direction. */
  height: number;
  /** Text direction: the first column of the text matrix (`a`, `b`). */
  dirX: number;
  dirY: number;
  /** The engine marked this item right-to-left: keep its content-stream order. */
  rtl: boolean;
}

export interface LayoutParagraph<T extends LayoutItem> {
  /** The paragraph text, part by part: page items and inserted spaces (`item` undefined). */
  parts: Array<{ text: string; item?: T }>;
  /** A heading level from the font size, only when the caller asked for headings. */
  heading?: 1 | 2 | 3;
}

export interface LayoutOptions {
  /** Detect headings by font size relative to the page body text (only without an outline). */
  headings: boolean;
}

interface Box<T> {
  item: T;
  text: string;
  /** Content-stream index: the final tie-breaker of every sort. */
  index: number;
  x0: number;
  x1: number;
  baseline: number;
  size: number;
  /** A whitespace item came between this item and the previous one in the content stream. */
  spaceBefore: boolean;
  rtl: boolean;
}

interface Segment<T> {
  boxes: Box<T>[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  index: number;
  rtl: boolean;
}

interface Line<T> {
  segments: Segment<T>[];
  x0: number;
  x1: number;
  baseline: number;
  size: number;
}

/** Coordinates are rounded to 1/100 pt before any comparison. */
const round = (value: number) => Math.round(value * 100) / 100;
const MAX_COORDINATE = 1e7;
/** XY-cut depth: deeper nodes are read top to bottom as they are. */
const MAX_CUT_DEPTH = 32;
/** Gutter candidates validated per node. */
const MAX_GUTTER_CANDIDATES = 8;
/** Items in one row further apart than this many font sizes are separate segments. */
const SEGMENT_GAP = 1.5;
/** ... or this many, when they are not next to each other in the content stream. */
const SEGMENT_GAP_APART = 0.6;
/** A gap wider than this many font sizes between two items is a word space. */
const WORD_GAP = 0.2;
/** A column's lines have a median width of at least this many font sizes. */
const COLUMN_MIN_WIDTH = 5;
/** A baseline step above this many font sizes starts a new paragraph. */
const PARAGRAPH_GAP = 1.6;
/** Lines whose font sizes differ by this ratio are in different paragraphs. */
const SIZE_BREAK = 1.2;
/** Paragraph text at least this many times the body size is a heading. */
const HEADING_SIZE = 1.25;
const BULLETS = new Set(['•', '●', '◦', '▪', '■', '□', '‣', '⁃', '➢', '►', '✓', '❖']);
const SENTENCE_END = new Set(['.', '!', '?', ':', '"', '”', '’', ')']);

const isBlank = (text: string) => text.trim().length === 0;
/** The value at `fraction` of the sorted values (sorts in place); 0 for none. */
const quantile = (values: number[], fraction: number) => {
  values.sort((a, b) => a - b);
  return values.length === 0 ? 0 : values[Math.floor((values.length - 1) * fraction)]!;
};
const median = (values: number[]) => quantile(values, 0.5);

/** The quarter turn (0-3) of a text direction, or -1 for skewed text. */
function quarter(dirX: number, dirY: number): number {
  if (!Number.isFinite(dirX) || !Number.isFinite(dirY) || (dirX === 0 && dirY === 0)) return 0;
  const length = Math.hypot(dirX, dirY);
  const x = dirX / length;
  const y = dirY / length;
  // Within about 10 degrees of a quarter turn.
  if (x > 0.985) return 0;
  if (y > 0.985) return 1;
  if (x < -0.985) return 2;
  if (y < -0.985) return 3;
  return -1;
}

/** Items as boxes in a frame where their text runs left to right and `baseline` grows downwards. */
function boxesOf<T extends LayoutItem>(items: readonly T[], budget: Budget) {
  const groups = new Map<number, { boxes: Box<T>[]; chars: number }>();
  let spaceBefore = false;
  for (let index = 0; index < items.length; index++) {
    budget.tick();
    const item = items[index]!;
    if (isBlank(item.text)) {
      spaceBefore = item.text.length > 0 || spaceBefore;
      continue;
    }
    const turn = quarter(item.dirX, item.dirY);
    // Exact quarter-turn unit vectors keep the frame free of rounding drift; skewed text keeps x.
    const [ux, uy] = turn === 1 ? [0, 1] : turn === 2 ? [-1, 0] : turn === 3 ? [0, -1] : [1, 0];
    const along = item.x * ux + item.y * uy;
    const down = item.x * uy - item.y * ux;
    const width = Number.isFinite(item.width) ? Math.max(0, item.width) : 0;
    const size = Number.isFinite(item.height) && item.height > 0 ? item.height : 1;
    if (![along, down].every((value) => Number.isFinite(value) && Math.abs(value) < MAX_COORDINATE)) continue;
    const group = groups.get(turn) ?? { boxes: [], chars: 0 };
    group.boxes.push({
      item,
      text: item.text,
      index,
      x0: round(along),
      x1: round(along + Math.min(width, MAX_COORDINATE)),
      baseline: round(down),
      size: round(Math.min(size, MAX_COORDINATE)),
      spaceBefore,
      rtl: item.rtl,
    });
    group.chars += item.text.length;
    groups.set(turn, group);
    spaceBefore = false;
  }
  // The direction with the most text comes first, then the other quarter turns, then skewed text.
  const ordered = [...groups].sort(([turnA, a], [turnB, b]) => {
    budget.tick();
    return Number(turnA === -1) - Number(turnB === -1) || b.chars - a.chars || turnA - turnB;
  });
  return ordered.map(([turn, group]) => ({ turn, boxes: group.boxes }));
}

function segmentOf<T>(boxes: Box<T>[], baseline: number, budget: Budget): Segment<T> {
  let x0 = Infinity;
  let x1 = -Infinity;
  let size = 0;
  let index = Infinity;
  let rtl = 0;
  for (const box of boxes) {
    budget.tick();
    x0 = Math.min(x0, box.x0);
    x1 = Math.max(x1, box.x1);
    size = Math.max(size, box.size);
    index = Math.min(index, box.index);
    rtl += box.rtl ? box.text.length : -box.text.length;
  }
  // Right-to-left text keeps its logical (content-stream) order.
  if (rtl > 0) boxes.sort((a, b) => a.index - b.index);
  return {
    boxes,
    x0,
    x1,
    top: round(baseline - size),
    bottom: round(baseline + size * 0.25),
    baseline,
    size,
    index,
    rtl: rtl > 0,
  };
}

/** Rows of boxes on one baseline, split into segments at wide gaps (column gutters, table cells). */
function segmentsOf<T>(boxes: Box<T>[], budget: Budget): Segment<T>[] {
  boxes.sort((a, b) => {
    budget.tick();
    return a.baseline - b.baseline || a.x0 - b.x0 || a.index - b.index;
  });
  const rows: Array<{ boxes: Box<T>[]; baseline: number; size: number }> = [];
  let row: (typeof rows)[number] | undefined;
  for (const box of boxes) {
    budget.tick();
    // A superscript or subscript sits within half a font size of the row's baseline.
    if (row && Math.abs(box.baseline - row.baseline) <= 0.5 * Math.max(row.size, box.size)) {
      row.boxes.push(box);
      if (box.size > row.size) {
        row.size = box.size;
        row.baseline = box.baseline;
      }
      continue;
    }
    row = { boxes: [box], baseline: box.baseline, size: box.size };
    rows.push(row);
  }
  const segments: Segment<T>[] = [];
  for (const { boxes: rowBoxes, baseline } of rows) {
    budget.tick();
    rowBoxes.sort((a, b) => {
      budget.tick();
      return a.x0 - b.x0 || a.index - b.index;
    });
    let current: Box<T>[] = [];
    let right = -Infinity;
    let last: Box<T> | undefined;
    for (const box of rowBoxes) {
      budget.tick();
      if (last) {
        const gap = box.x0 - right;
        const size = Math.max(last.size, box.size);
        const apart = Math.abs(box.index - last.index) > 2;
        if (gap > SEGMENT_GAP * size || (apart && gap > SEGMENT_GAP_APART * size)) {
          segments.push(segmentOf(current, baseline, budget));
          current = [];
          right = -Infinity;
        }
      }
      current.push(box);
      right = Math.max(right, box.x1);
      last = box;
    }
    if (current.length > 0) segments.push(segmentOf(current, baseline, budget));
  }
  return segments;
}

/**
 * The best vertical gutter of a node: an x-range at least `minGap` wide that few segments cross,
 * with column-like text on both sides that overlaps vertically. The segments that cross it are
 * blockers (titles, full-width figures, footnotes) that split the node into horizontal bands.
 */
function gutterOf<T>(
  segments: Segment<T>[],
  budget: Budget,
): { left: Segment<T>[]; right: Segment<T>[]; blockers: Set<Segment<T>> } | undefined {
  const sizes: number[] = [];
  let left = Infinity;
  let right = -Infinity;
  for (const segment of segments) {
    budget.tick();
    sizes.push(segment.size);
    left = Math.min(left, segment.x0);
    right = Math.max(right, segment.x1);
  }
  const size = median(sizes);
  const minGap = Math.max(SEGMENT_GAP_APART * size, 2);
  const allowed = Math.floor((segments.length - 1) / 2);
  // Sweep segment edges; ends sort before starts at the same x.
  const edges: Array<[number, number]> = [];
  for (const segment of segments) {
    budget.tick();
    edges.push([segment.x0, 1], [segment.x1, -1]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const candidates: Array<{ start: number; end: number; crossing: number }> = [];
  let covered = 0;
  for (let index = 0; index < edges.length; index++) {
    budget.tick();
    const [x, delta] = edges[index]!;
    covered += delta;
    const next = edges[index + 1];
    if (next === undefined || x <= left || next[0] >= right) continue;
    if (covered <= allowed && next[0] - x >= minGap)
      candidates.push({ start: x, end: next[0], crossing: covered });
  }
  candidates.sort(
    (a, b) => a.crossing - b.crossing || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  for (const candidate of candidates.slice(0, MAX_GUTTER_CANDIDATES)) {
    budget.tick();
    const sides = [[], []] as [Segment<T>[], Segment<T>[]];
    const blockers = new Set<Segment<T>>();
    for (const segment of segments) {
      budget.tick();
      if (segment.x1 <= candidate.start) sides[0].push(segment);
      else if (segment.x0 >= candidate.end) sides[1].push(segment);
      else blockers.add(segment);
    }
    if (sides.some((side) => !isColumn(side, size, budget))) continue;
    // Lines that stick out of a column towards the gutter (a centred title beside a narrow gap)
    // are blockers too. The edges are quartiles, so a side that holds two columns keeps both.
    const leftEdge = quantile(
      sides[0].map((segment) => segment.x1),
      0.75,
    );
    const rightEdge = quantile(
      sides[1].map((segment) => segment.x0),
      0.25,
    );
    const left = sides[0].filter((segment) => segment.x1 <= leftEdge + 2 * size || !blockers.add(segment));
    const right = sides[1].filter((segment) => segment.x0 >= rightEdge - minGap || !blockers.add(segment));
    if (!isColumn(left, size, budget) || !isColumn(right, size, budget)) continue;
    const [top0, bottom0] = extent(left);
    const [top1, bottom1] = extent(right);
    if (Math.min(bottom0, bottom1) - Math.max(top0, top1) < 2 * size) continue;
    return { left, right, blockers };
  }
  return undefined;
}

/** Two or more segments whose median width is at least a few words. */
function isColumn<T>(side: Segment<T>[], size: number, budget: Budget): boolean {
  if (side.length < 2) return false;
  const widths: number[] = [];
  for (const segment of side) {
    budget.tick();
    widths.push(segment.x1 - segment.x0);
  }
  return median(widths) >= COLUMN_MIN_WIDTH * size;
}

function extent<T>(segments: Segment<T>[]): [number, number] {
  let top = Infinity;
  let bottom = -Infinity;
  for (const segment of segments) {
    top = Math.min(top, segment.top);
    bottom = Math.max(bottom, segment.bottom);
  }
  return [top, bottom];
}

const byPosition = <T>(a: Segment<T>, b: Segment<T>) =>
  a.baseline - b.baseline || a.x0 - b.x0 || a.index - b.index;

/**
 * Recursive XY-cut, walked with an explicit stack: split at the best gutter (left column first),
 * cutting horizontally around segments that cross it. Leaves are read top to bottom.
 */
function columnsOf<T>(segments: Segment<T>[], budget: Budget): Segment<T>[][] {
  const leaves: Segment<T>[][] = [];
  const stack: Array<{ segments: Segment<T>[]; depth: number; leaf: boolean }> = [
    { segments, depth: 0, leaf: false },
  ];
  while (stack.length > 0) {
    budget.tick();
    const node = stack.pop()!;
    const gutter =
      node.leaf || node.segments.length < 4 || node.depth >= MAX_CUT_DEPTH
        ? undefined
        : gutterOf(node.segments, budget);
    if (!gutter) {
      leaves.push(node.segments.sort(byPosition));
      continue;
    }
    const children: Array<{ segments: Segment<T>[]; depth: number; leaf: boolean }> = [];
    if (gutter.blockers.size === 0) {
      children.push({ segments: gutter.left, depth: node.depth + 1, leaf: false });
      children.push({ segments: gutter.right, depth: node.depth + 1, leaf: false });
    } else {
      // Bands from top to bottom: runs of column text between runs of blockers.
      node.segments.sort((a, b) => {
        budget.tick();
        return a.top - b.top || byPosition(a, b);
      });
      for (const segment of node.segments) {
        budget.tick();
        const blocker = gutter.blockers.has(segment);
        const band = children.at(-1);
        if (band && band.leaf === blocker) band.segments.push(segment);
        else children.push({ segments: [segment], depth: node.depth + 1, leaf: blocker });
      }
    }
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
  }
  return leaves;
}

/** Segments of a column that share a row become one line, left to right. */
function linesOf<T>(column: Segment<T>[], budget: Budget): Line<T>[] {
  const lines: Line<T>[] = [];
  for (const segment of column) {
    budget.tick();
    const line = lines.at(-1);
    if (line && Math.abs(segment.baseline - line.baseline) <= 0.5 * Math.max(line.size, segment.size)) {
      line.segments.push(segment);
      line.x0 = Math.min(line.x0, segment.x0);
      line.x1 = Math.max(line.x1, segment.x1);
      line.size = Math.max(line.size, segment.size);
      continue;
    }
    lines.push({
      segments: [segment],
      x0: segment.x0,
      x1: segment.x1,
      baseline: segment.baseline,
      size: segment.size,
    });
  }
  for (const line of lines) {
    budget.tick();
    // A right-to-left line reads its segments from the right.
    const rtl = line.segments.filter((segment) => segment.rtl).length * 2 > line.segments.length;
    line.segments.sort((a, b) => (rtl ? b.x1 - a.x1 : a.x0 - b.x0) || a.index - b.index);
  }
  return lines;
}

/** Does `next` start a new paragraph after `previous` in a column whose left edge is `margin`? */
function breaksBefore<T>(
  previous: Line<T>,
  next: Line<T>,
  margin: number,
  right: number,
  first: string,
): boolean {
  const size = Math.max(previous.size, next.size);
  if (size / Math.min(previous.size, next.size) >= SIZE_BREAK) return true;
  // A row split by wide gaps (a table or form row) stands alone.
  if (previous.segments.length > 1 || next.segments.length > 1) return true;
  const step = next.baseline - previous.baseline;
  if (step <= 0 || step > PARAGRAPH_GAP * size) return true;
  // A bullet, or a symbol-font glyph in the Private Use Area, opens a list item.
  const code = first.charCodeAt(0);
  if (BULLETS.has(first) || (code >= 0xe000 && code <= 0xf8ff)) return true;
  // A first-line indent after a line that ends a sentence or stops short of the right edge.
  const indented = next.x0 - margin > 0.8 * size && previous.x0 - margin <= 0.8 * size;
  const lastText = previous.segments.at(-1)!.boxes.at(-1)!.text.trimEnd();
  const ended = SENTENCE_END.has(lastText.charAt(lastText.length - 1)) || right - previous.x1 > 2 * size;
  return indented && ended;
}

type Parts<T> = LayoutParagraph<T & LayoutItem>['parts'];

function pushText<T extends LayoutItem>(parts: Parts<T>, box: Box<T>, previous: Box<T> | undefined) {
  if (previous) {
    const gap = box.x0 - previous.x1;
    const raised = Math.abs(box.baseline - previous.baseline) > 0.15 * Math.max(box.size, previous.size);
    const spaced = /\s$/u.test(previous.text) || /^\s/u.test(box.text);
    if (!spaced && (box.spaceBefore || (gap > WORD_GAP * Math.max(box.size, previous.size) && !raised)))
      parts.push({ text: ' ' });
  }
  parts.push({ text: box.text, item: box.item });
}

const LOWER = /^\p{Ll}/u;
const LETTER = /^\p{L}/u;

/** Join a line to a paragraph: a space, or nothing after a line-end hyphen before a lowercase word. */
function joinLine<T extends LayoutItem>(parts: Parts<T>, firstText: string) {
  const last = parts.at(-1);
  if (!last) return;
  const text = last.text;
  if (
    last.item !== undefined &&
    text.length >= 2 &&
    text.endsWith('-') &&
    LETTER.test(text.charAt(text.length - 2)) &&
    LOWER.test(firstText.trimStart())
  ) {
    parts[parts.length - 1] = { text: text.slice(0, -1), item: last.item };
    return;
  }
  if (!/\s$/u.test(text)) parts.push({ text: ' ' });
}

function lineParts<T extends LayoutItem>(parts: Parts<T>, line: Line<T>, budget: Budget) {
  let previous: Box<T> | undefined;
  for (const [index, segment] of line.segments.entries()) {
    budget.tick();
    if (index > 0) parts.push({ text: ' ' });
    previous = undefined;
    for (const box of segment.boxes) {
      budget.tick();
      pushText(parts, box, previous);
      previous = box;
    }
  }
}

function firstText<T>(line: Line<T>): string {
  return line.segments[0]!.boxes[0]!.text.trimStart();
}

/** Paragraphs of one direction's boxes, column by column. */
function paragraphsOf<T extends LayoutItem>(boxes: Box<T>[], budget: Budget) {
  const paragraphs: Array<{ parts: Parts<T>; lines: Line<T>[] }> = [];
  let carried: { paragraph: (typeof paragraphs)[number]; line: Line<T> } | undefined;
  for (const column of columnsOf(segmentsOf(boxes, budget), budget)) {
    budget.tick();
    const lines = linesOf(column, budget);
    let margin = Infinity;
    let right = -Infinity;
    for (const line of lines) {
      margin = Math.min(margin, line.x0);
      right = Math.max(right, line.x1);
    }
    let current: (typeof paragraphs)[number] | undefined;
    let previous: Line<T> | undefined;
    // A paragraph that runs on from the previous column: no sentence end before a lowercase word.
    const head = lines[0];
    if (carried && head && continues(carried.line, head)) {
      current = carried.paragraph;
      previous = carried.line;
    }
    for (const line of lines) {
      budget.tick();
      const first = firstText(line);
      if (
        !current ||
        !previous ||
        (previous !== carried?.line && breaksBefore(previous, line, margin, right, first.charAt(0)))
      ) {
        current = { parts: [], lines: [] };
        paragraphs.push(current);
      } else {
        joinLine(current.parts, first);
      }
      lineParts(current.parts, line, budget);
      current.lines.push(line);
      previous = line;
    }
    carried = current && previous ? { paragraph: current, line: previous } : undefined;
  }
  return paragraphs;
}

function continues<T>(previous: Line<T>, next: Line<T>): boolean {
  if (previous.segments.length > 1 || next.segments.length > 1) return false;
  if (Math.max(previous.size, next.size) / Math.min(previous.size, next.size) >= SIZE_BREAK) return false;
  const lastText = previous.segments[0]!.boxes.at(-1)!.text.trimEnd();
  return !SENTENCE_END.has(lastText.charAt(lastText.length - 1)) && LOWER.test(firstText(next));
}

/** Lay out one page's text items as paragraphs in reading order. */
export function layoutPage<T extends LayoutItem>(
  items: readonly T[],
  options: LayoutOptions,
  budget: Budget,
): LayoutParagraph<T>[] {
  const result: LayoutParagraph<T>[] = [];
  for (const [position, { turn, boxes }] of boxesOf(items, budget).entries()) {
    budget.tick();
    if (turn === -1) {
      // Skewed text has no shared baseline: one paragraph per item, in content-stream order.
      boxes.sort((a, b) => a.index - b.index);
      for (const box of boxes) {
        budget.tick();
        result.push({ parts: [{ text: box.text, item: box.item }] });
      }
      continue;
    }
    // Headings compare with the body size of the main direction: the median size by characters.
    let body = 0;
    if (options.headings && position === 0) {
      const sizes: number[] = [];
      for (const box of boxes) {
        budget.tick();
        for (let count = 0; count < Math.min(box.text.length, 64); count++) sizes.push(box.size);
      }
      body = median(sizes);
    }
    for (const { parts, lines } of paragraphsOf(boxes, budget)) {
      budget.tick();
      const paragraph: LayoutParagraph<T> = { parts };
      if (body > 0 && lines.length <= 3) {
        let size = Infinity;
        let length = 0;
        for (const part of parts) length += part.text.length;
        for (const line of lines) size = Math.min(size, line.size);
        const ratio = size / body;
        if (ratio >= HEADING_SIZE && length <= 200)
          paragraph.heading = ratio >= 1.9 ? 1 : ratio >= 1.5 ? 2 : 3;
      }
      result.push(paragraph);
    }
  }
  return result;
}

import type { Budget } from '../../../core/budget.js';
import type { LayoutLine } from '../layout/layout.js';

export type HeaderFooterMode = 'remove' | 'keep';
export type HeaderFooterRole = 'header' | 'footer';

/** One page's ordered lines and dimensions from the private PDF layout stage. */
export interface HeaderFooterPage {
  /** Zero-based source page index. Parity is calculated from index + 1. */
  index: number;
  width: number;
  height: number;
  lines: readonly LayoutLine[];
}

/** A repeated line emitted once, with source-page provenance and representative geometry. */
export interface RepeatedHeaderFooter {
  role: HeaderFooterRole;
  /** The original text from the earliest matching page. */
  text: string;
  /** Text identity used for matching after whitespace and digit normalization. */
  normalizedText: string;
  /** Unique zero-based source page indices, in ascending order. */
  pageIndices: readonly number[];
  /** Earliest occurrence used as the representative position. */
  pageIndex: number;
  position: { x: number; y: number };
  line: LayoutLine;
}

export interface HeaderFooterResult {
  pages: Array<{ index: number; lines: readonly LayoutLine[] }>;
  groups: RepeatedHeaderFooter[];
}

interface Occurrence {
  pageSlot: number;
  pageIndex: number;
  lineIndex: number;
}

interface CandidateGroup {
  role: HeaderFooterRole;
  normalizedText: string;
  anchorX: number;
  anchorY: number;
  bucketX: number;
  bucketY: number;
  firstOrder: number;
  firstPageIndex: number;
  firstLine: LayoutLine;
  occurrences: Occurrence[];
  pageIndices: Set<number>;
}

interface Candidate {
  role: HeaderFooterRole;
  normalizedText: string;
  x: number;
  y: number;
}

type CandidateResult =
  { status: 'candidate'; candidate: Candidate } | { status: 'skip' } | { status: 'limit' };

const TOP_BAND = 0.1;
const BOTTOM_BAND = 0.9;
const X_TOLERANCE = 0.03;
const Y_TOLERANCE = 0.015;
const ROUND_FACTOR = 1000;
const MAX_LINE_TEXT = 1_000_000;
const DIGIT = /^\p{Nd}$/u;
const WHITESPACE = /^\s$/u;

function round(value: number): number {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

/** NFC text with whitespace runs collapsed and each consecutive decimal run replaced by #. */
function normalizeLineText(text: string, budget: Budget): string {
  if (text.length > MAX_LINE_TEXT) return '';
  const normalized = text.normalize('NFC');
  const parts: string[] = [];
  let digitRun = false;
  let whitespaceRun = false;
  for (const character of normalized) {
    budget.tick();
    if (WHITESPACE.test(character)) {
      digitRun = false;
      if (parts.length > 0 && !whitespaceRun) parts.push(' ');
      whitespaceRun = true;
    } else if (DIGIT.test(character)) {
      whitespaceRun = false;
      if (!digitRun) parts.push('#');
      digitRun = true;
    } else {
      whitespaceRun = false;
      digitRun = false;
      parts.push(character);
    }
  }
  if (parts[parts.length - 1] === ' ') parts.pop();
  return parts.join('');
}

function candidateFor(
  page: HeaderFooterPage,
  line: LayoutLine,
  budget: Budget,
  stagedTextChars: number,
): CandidateResult {
  budget.tick();
  if (
    !Number.isFinite(page.width) ||
    !Number.isFinite(page.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    !Number.isFinite(page.index) ||
    !Number.isSafeInteger(page.index) ||
    page.index < 0 ||
    typeof line.text !== 'string' ||
    !Number.isFinite(line.x) ||
    !Number.isFinite(line.y) ||
    !Number.isFinite(line.width) ||
    !Number.isFinite(line.height) ||
    line.width < 0 ||
    line.height < 0
  )
    return { status: 'skip' };

  const centerX = (line.x + line.width / 2) / page.width;
  // LayoutLine.y is the lower edge/baseline in the rotated, top-left page space.
  const centerY = (line.y - line.height / 2) / page.height;
  if (centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1) return { status: 'skip' };
  const role: HeaderFooterRole | undefined =
    centerY <= TOP_BAND ? 'header' : centerY >= BOTTOM_BAND ? 'footer' : undefined;
  if (!role) return { status: 'skip' };
  // Preflight before normalization allocates its parts array/string. The
  // staged amount is not charged; checkOutputChars includes prior shared use.
  if (!budget.checkOutputChars(stagedTextChars + line.text.length)) return { status: 'limit' };
  const normalizedText = normalizeLineText(line.text, budget);
  if (!normalizedText) return { status: 'skip' };
  return {
    status: 'candidate',
    candidate: { role, normalizedText, x: round(centerX), y: round(centerY) },
  };
}

function bucketKey(role: HeaderFooterRole, normalizedText: string): string {
  return `${role}\u0000${normalizedText}`;
}

function withinTolerance(group: CandidateGroup, candidate: Candidate): boolean {
  return (
    Math.abs(group.anchorX - candidate.x) <= X_TOLERANCE &&
    Math.abs(group.anchorY - candidate.y) <= Y_TOLERANCE
  );
}

function findGroup(
  buckets: Map<string, Map<number, Map<number, CandidateGroup>>>,
  candidate: Candidate,
  budget: Budget,
): CandidateGroup | undefined {
  const textBuckets = buckets.get(bucketKey(candidate.role, candidate.normalizedText));
  if (!textBuckets) return undefined;
  const bucketX = Math.floor(candidate.x / X_TOLERANCE);
  const bucketY = Math.floor(candidate.y / Y_TOLERANCE);
  let best: CandidateGroup | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      budget.tick();
      const group = textBuckets.get(bucketX + dx)?.get(bucketY + dy);
      if (!group || !withinTolerance(group, candidate)) continue;
      const xDistance = group.anchorX - candidate.x;
      const yDistance = group.anchorY - candidate.y;
      const distance = xDistance * xDistance + yDistance * yDistance;
      if (
        distance < bestDistance ||
        (distance === bestDistance && group.firstOrder < (best?.firstOrder ?? Number.POSITIVE_INFINITY))
      ) {
        best = group;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function addGroup(
  buckets: Map<string, Map<number, Map<number, CandidateGroup>>>,
  candidate: Candidate,
  order: number,
  pageIndex: number,
  line: LayoutLine,
): CandidateGroup {
  const normalizedKey = bucketKey(candidate.role, candidate.normalizedText);
  let textBuckets = buckets.get(normalizedKey);
  if (!textBuckets) {
    textBuckets = new Map();
    buckets.set(normalizedKey, textBuckets);
  }
  const bucketX = Math.floor(candidate.x / X_TOLERANCE);
  const bucketY = Math.floor(candidate.y / Y_TOLERANCE);
  let yBuckets = textBuckets.get(bucketX);
  if (!yBuckets) {
    yBuckets = new Map();
    textBuckets.set(bucketX, yBuckets);
  }
  const group: CandidateGroup = {
    role: candidate.role,
    normalizedText: candidate.normalizedText,
    anchorX: candidate.x,
    anchorY: candidate.y,
    bucketX,
    bucketY,
    firstOrder: order,
    firstPageIndex: pageIndex,
    firstLine: line,
    occurrences: [],
    pageIndices: new Set(),
  };
  yBuckets.set(bucketY, group);
  return group;
}

function qualifies(
  group: CandidateGroup,
  totalPages: number,
  parityPageCounts: readonly [number, number],
  budget: Budget,
): boolean {
  const matches = group.pageIndices.size;
  if (totalPages >= 3 && matches >= 3 && 5 * matches >= 3 * totalPages) return true;
  if (group.role !== 'header') return false;
  const parityMatches: [number, number] = [0, 0];
  for (const pageIndex of group.pageIndices) {
    budget.tick();
    parityMatches[(pageIndex + 1) % 2]! += 1;
  }
  for (let parity = 0; parity < 2; parity += 1) {
    if (
      parityPageCounts[parity]! >= 3 &&
      parityMatches[parity]! >= 3 &&
      5 * parityMatches[parity]! >= 3 * parityPageCounts[parity]!
    )
      return true;
  }
  return false;
}

function unchangedResult(pages: readonly HeaderFooterPage[], budget: Budget): HeaderFooterResult {
  const output: HeaderFooterResult['pages'] = [];
  for (const page of pages) {
    budget.tick();
    output.push({ index: page.index, lines: page.lines });
  }
  return { pages: output, groups: [] };
}

/**
 * Detect repeated line groups in the top and bottom 10% of pages. Matching
 * uses digit-normalized NFC text and rounded normalized position. All-page
 * groups use a 60%/three-page threshold; header parity cohorts allow alternating
 * odd/even variants when each cohort independently reaches that threshold.
 *
 * The helper only stages references and classification metadata. It does not
 * charge output characters; the eventual DocBuilder emission owns that charge.
 */
export function detectRepeatedHeadersFooters(
  pages: readonly HeaderFooterPage[],
  budget: Budget,
  mode: HeaderFooterMode = 'remove',
): HeaderFooterResult {
  budget.tick();
  if (mode === 'keep' || budget.truncated || !budget.canRead) return unchangedResult(pages, budget);

  const pageIndices = new Set<number>();
  const parityPageIndices: [Set<number>, Set<number>] = [new Set(), new Set()];
  for (const page of pages) {
    budget.tick();
    if (Number.isSafeInteger(page.index) && page.index >= 0 && !pageIndices.has(page.index)) {
      pageIndices.add(page.index);
      parityPageIndices[(page.index + 1) % 2]!.add(page.index);
    }
  }
  const parityPageCounts: [number, number] = [parityPageIndices[0].size, parityPageIndices[1].size];
  const buckets = new Map<string, Map<number, Map<number, CandidateGroup>>>();
  const groups: CandidateGroup[] = [];
  let stagedUniqueTextChars = 0;
  let order = 0;
  let stagingLimit = false;
  for (let pageSlot = 0; pageSlot < pages.length; pageSlot += 1) {
    budget.tick();
    const page = pages[pageSlot]!;
    for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
      budget.tick();
      const line = page.lines[lineIndex]!;
      const candidateResult = candidateFor(page, line, budget, stagedUniqueTextChars);
      if (candidateResult.status === 'limit') {
        stagingLimit = true;
        break;
      }
      if (candidateResult.status === 'skip') continue;
      const { candidate } = candidateResult;
      let group = findGroup(buckets, candidate, budget);
      if (!group) {
        const nextStagedTextChars = stagedUniqueTextChars + candidate.normalizedText.length;
        if (!budget.checkOutputChars(nextStagedTextChars)) {
          stagingLimit = true;
          break;
        }
        group = addGroup(buckets, candidate, order++, page.index, line);
        groups.push(group);
        stagedUniqueTextChars = nextStagedTextChars;
      }
      group.occurrences.push({ pageSlot, pageIndex: page.index, lineIndex });
      group.pageIndices.add(page.index);
    }
    if (stagingLimit) break;
  }
  if (stagingLimit || budget.truncated || !budget.canRead) return unchangedResult(pages, budget);

  const removeIndices = new Map<number, Set<number>>();
  const repeated: RepeatedHeaderFooter[] = [];
  for (const group of groups) {
    budget.tick();
    if (!qualifies(group, pageIndices.size, parityPageCounts, budget)) continue;
    for (const occurrence of group.occurrences) {
      budget.tick();
      let indices = removeIndices.get(occurrence.pageSlot);
      if (!indices) {
        indices = new Set();
        removeIndices.set(occurrence.pageSlot, indices);
      }
      indices.add(occurrence.lineIndex);
    }
    const pageIndicesSorted: number[] = [];
    for (const pageIndex of group.pageIndices) {
      budget.tick();
      pageIndicesSorted.push(pageIndex);
    }
    pageIndicesSorted.sort((a, b) => {
      budget.tick();
      return a - b;
    });
    repeated.push({
      role: group.role,
      text: group.firstLine.text,
      normalizedText: group.normalizedText,
      pageIndices: pageIndicesSorted,
      pageIndex: group.firstPageIndex,
      position: { x: group.anchorX, y: group.anchorY },
      line: group.firstLine,
    });
  }

  repeated.sort((a, b) => {
    budget.tick();
    const roleOrder = (a.role === 'header' ? 0 : 1) - (b.role === 'header' ? 0 : 1);
    return (
      roleOrder ||
      a.position.y - b.position.y ||
      a.position.x - b.position.x ||
      a.pageIndex - b.pageIndex ||
      a.line.sourceIndex - b.line.sourceIndex ||
      (a.normalizedText < b.normalizedText ? -1 : a.normalizedText > b.normalizedText ? 1 : 0)
    );
  });

  const outputPages: HeaderFooterResult['pages'] = [];
  for (let pageSlot = 0; pageSlot < pages.length; pageSlot += 1) {
    budget.tick();
    const page = pages[pageSlot]!;
    const removed = removeIndices.get(pageSlot);
    if (!removed) {
      outputPages.push({ index: page.index, lines: page.lines });
      continue;
    }
    const lines: LayoutLine[] = [];
    for (let lineIndex = 0; lineIndex < page.lines.length; lineIndex += 1) {
      budget.tick();
      if (!removed.has(lineIndex)) lines.push(page.lines[lineIndex]!);
    }
    outputPages.push({ index: page.index, lines });
  }
  return { pages: outputPages, groups: repeated };
}

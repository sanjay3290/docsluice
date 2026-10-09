import type { Budget } from '../../../core/budget.js';

/** PDF.js-like text input. `transform` is [a,b,c,d,e,f], in PDF user space. */
export interface TextItem {
  text: string;
  transform: readonly [number, number, number, number, number, number];
  width: number;
  height: number;
  fontSize: number;
  dir: 'ltr' | 'rtl';
  sourceIndex: number;
}

/** Unrotated media-box dimensions and clockwise page rotation in degrees. */
export interface LayoutPage {
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface LayoutOptions {
  /** Suppress font-size heading guesses when a document outline supplies headings. */
  outlinePresent?: boolean;
}

export interface LayoutLine {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
  dir: 'ltr' | 'rtl';
  sourceIndex: number;
  sourceIndices: readonly number[];
  column: number;
}

export interface LayoutParagraph {
  text: string;
  lines: readonly LayoutLine[];
  heading: boolean;
}

export interface LayoutResult {
  page: { width: number; height: number };
  lines: readonly LayoutLine[];
  paragraphs: readonly LayoutParagraph[];
  /** Adapter must report these skipped items with a static, content-free warning. */
  unsupportedDirectionItems: number;
}

interface Box {
  text: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  baseline: number;
  fontSize: number;
  dir: 'ltr' | 'rtl';
  sourceIndex: number;
  stableIndex: number;
}

interface LineGroup {
  boxes: Box[];
  baseline: number;
}

interface TextStage {
  used: number;
}

const ROUND_FACTOR = 1000;
const MAX_PAGE_EXTENT = 10_000_000;
const MAX_ITEM_EXTENT = 1_000_000;
const MAX_FONT_SIZE = 100_000;
const MAX_ITEM_TEXT = 1_000_000;

function round(value: number): number {
  return Math.round(value * ROUND_FACTOR) / ROUND_FACTOR;
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_PAGE_EXTENT;
}

function pageDimensions(page: LayoutPage): { width: number; height: number } | undefined {
  if (!finitePositive(page.width) || !finitePositive(page.height)) return undefined;
  if (page.rotation !== 0 && page.rotation !== 90 && page.rotation !== 180 && page.rotation !== 270)
    return undefined;
  if (page.rotation === 90 || page.rotation === 270)
    return { width: round(page.height), height: round(page.width) };
  return { width: round(page.width), height: round(page.height) };
}

function rotatePoint(x: number, y: number, page: LayoutPage): [number, number] {
  switch (page.rotation) {
    case 90:
      return [page.height - y, x];
    case 180:
      return [page.width - x, page.height - y];
    case 270:
      return [y, page.width - x];
    default:
      return [x, y];
  }
}

function itemOrientation(item: TextItem, budget: Budget): LayoutPage['rotation'] | undefined {
  budget.tick();
  if (item === null || typeof item !== 'object') return undefined;
  if (typeof item.text !== 'string' || item.text.length > MAX_ITEM_TEXT || item.text.trim().length === 0)
    return undefined;
  const transform = item.transform;
  if (!Array.isArray(transform) || transform.length !== 6 || !transform.every(Number.isFinite))
    return undefined;
  const [a, b, c, d] = transform;
  const u = Math.hypot(a, b);
  const v = Math.hypot(c, d);
  if (u <= 0 || v <= 0) return undefined;
  const ux = a / u;
  const uy = b / u;
  const vx = c / v;
  const vy = d / v;
  // Only canonical quarter-turn text frames are safe to analyze geometrically.
  if (Math.abs(ux * vx + uy * vy) > 0.02 || vx * -uy + vy * ux < 0.98) return undefined;
  if (Math.abs(uy) <= 0.02 && ux > 0.98) return 0;
  if (Math.abs(ux) <= 0.02 && uy > 0.98) return 90;
  if (Math.abs(uy) <= 0.02 && ux < -0.98) return 180;
  if (Math.abs(ux) <= 0.02 && uy < -0.98) return 270;
  return undefined;
}

function analysisRotation(items: readonly TextItem[], budget: Budget): LayoutPage['rotation'] | undefined {
  let orientation: LayoutPage['rotation'] | undefined;
  for (const item of items) {
    budget.tick();
    if (
      item !== null &&
      typeof item === 'object' &&
      typeof item.text === 'string' &&
      item.text.length <= MAX_ITEM_TEXT &&
      item.text.trim().length === 0
    )
      continue;
    const candidate = itemOrientation(item, budget);
    if (candidate === undefined) return undefined;
    if (orientation !== undefined && candidate !== orientation) return undefined;
    orientation = candidate;
  }
  return orientation;
}

function remapLine(
  line: LayoutLine,
  analysisPage: LayoutPage,
  delta: LayoutPage['rotation'],
  budget: Budget,
): LayoutLine {
  if (delta === 0) return line;
  const corners: Array<[number, number]> = [
    [line.x, line.y - line.height],
    [line.x + line.width, line.y - line.height],
    [line.x, line.y],
    [line.x + line.width, line.y],
  ];
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of corners) {
    budget.tick();
    const [mappedX, mappedY] = rotatePoint(x, y, { ...analysisPage, rotation: delta });
    x0 = Math.min(x0, mappedX);
    x1 = Math.max(x1, mappedX);
    y0 = Math.min(y0, mappedY);
    y1 = Math.max(y1, mappedY);
  }
  return { ...line, x: round(x0), y: round(y1), width: round(x1 - x0), height: round(y1 - y0) };
}

function normalizeItem(
  item: TextItem,
  page: LayoutPage,
  budget: Budget,
  stableIndex: number,
): Box | undefined {
  if (
    item === null ||
    typeof item !== 'object' ||
    !Array.isArray(item.transform) ||
    item.transform.length !== 6
  )
    return undefined;
  const [a, b, c, d, e, f] = item.transform;
  if (
    typeof item.text !== 'string' ||
    item.text.length > MAX_ITEM_TEXT ||
    item.text.length === 0 ||
    ![a, b, c, d, e, f, item.width, item.height, item.fontSize, item.sourceIndex].every(Number.isFinite) ||
    Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d), Math.abs(e), Math.abs(f)) >
      MAX_PAGE_EXTENT ||
    item.width < 0 ||
    item.width > MAX_ITEM_EXTENT ||
    item.height < 0 ||
    item.height > MAX_ITEM_EXTENT ||
    item.fontSize <= 0 ||
    item.fontSize > MAX_FONT_SIZE ||
    (item.dir !== 'ltr' && item.dir !== 'rtl') ||
    !Number.isSafeInteger(item.sourceIndex) ||
    item.sourceIndex < 0
  )
    return undefined;

  const uLength = Math.hypot(a, b);
  const vLength = Math.hypot(c, d);
  const ux = uLength > 0 ? (a / uLength) * item.width : item.width;
  const uy = uLength > 0 ? (b / uLength) * item.width : 0;
  const vx = vLength > 0 ? (c / vLength) * item.height : 0;
  const vy = vLength > 0 ? (d / vLength) * item.height : item.height;
  const corners: Array<[number, number]> = [
    [e, f],
    [e + ux, f + uy],
    [e + vx, f + vy],
    [e + ux + vx, f + uy + vy],
  ];
  const points: Array<[number, number]> = [];
  for (const [x, y] of corners) {
    budget.tick();
    const nativeTopY = page.height - y;
    points.push(rotatePoint(x, nativeTopY, page));
  }
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    budget.tick();
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (
    Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) > MAX_PAGE_EXTENT ||
    ![x0, x1, y0, y1].every(Number.isFinite)
  )
    return undefined;
  return {
    text: item.text,
    x0: round(x0),
    x1: round(x1),
    y0: round(y0),
    y1: round(y1),
    baseline: round(y1),
    fontSize: round(item.fontSize),
    dir: item.dir === 'rtl' ? 'rtl' : 'ltr',
    sourceIndex: item.sourceIndex,
    stableIndex,
  };
}

function compareBoxes(a: Box, b: Box, budget: Budget): number {
  budget.tick();
  return (
    a.baseline - b.baseline || a.x0 - b.x0 || a.sourceIndex - b.sourceIndex || a.stableIndex - b.stableIndex
  );
}

function makeLine(group: LineGroup, budget: Budget, column = -1): LayoutLine {
  let rtl = false;
  for (const box of group.boxes) {
    budget.tick();
    rtl ||= box.dir === 'rtl';
  }
  group.boxes.sort((a, b) => {
    budget.tick();
    return (
      (rtl ? a.sourceIndex - b.sourceIndex : a.x0 - b.x0) ||
      a.sourceIndex - b.sourceIndex ||
      a.stableIndex - b.stableIndex
    );
  });
  const textParts: string[] = [];
  let previous: Box | undefined;
  let x0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let y0 = Number.POSITIVE_INFINITY;
  let y1 = Number.NEGATIVE_INFINITY;
  let fontSize = 0;
  let sourceIndex = Number.POSITIVE_INFINITY;
  const sourceIndices: number[] = [];
  for (const box of group.boxes) {
    budget.tick();
    if (previous) {
      const gap = rtl ? previous.x0 - box.x1 : box.x0 - previous.x1;
      const elevatedSmall =
        box.fontSize < fontSize * 0.8 && Math.abs(box.baseline - group.baseline) > fontSize * 0.2;
      const space = gap > Math.max(0, fontSize * 0.25) && !elevatedSmall;
      const previousChar = previous.text.charAt(previous.text.length - 1);
      const nextChar = box.text.charAt(0);
      const previousHasSpace = previousChar.length > 0 && previousChar.trim().length === 0;
      const nextHasSpace = nextChar.length > 0 && nextChar.trim().length === 0;
      if (space && !previousHasSpace && !nextHasSpace) textParts.push(' ');
    }
    const appendText =
      previous && previous.text.charAt(previous.text.length - 1).trim().length === 0
        ? box.text.trimStart()
        : box.text;
    if (appendText.length > 0) textParts.push(appendText);
    x0 = Math.min(x0, box.x0);
    x1 = Math.max(x1, box.x1);
    y0 = Math.min(y0, box.y0);
    y1 = Math.max(y1, box.y1);
    fontSize = Math.max(fontSize, box.fontSize);
    sourceIndex = Math.min(sourceIndex, box.sourceIndex);
    sourceIndices.push(box.sourceIndex);
    previous = box;
  }
  return {
    text: textParts.join('').trim(),
    x: round(x0),
    y: round(group.baseline),
    width: round(x1 - x0),
    height: round(y1 - y0),
    fontSize: round(fontSize),
    dir: rtl ? 'rtl' : 'ltr',
    sourceIndex,
    sourceIndices,
    column,
  };
}

function primaryBaseline(boxes: readonly Box[], budget: Budget): number {
  let baseline = boxes[0]!.baseline;
  let largestFont = boxes[0]!.fontSize;
  for (const box of boxes) {
    budget.tick();
    if (box.fontSize > largestFont) {
      largestFont = box.fontSize;
      baseline = box.baseline;
    }
  }
  return round(baseline);
}

function makeLines(boxes: Box[], pageWidth: number, budget: Budget): LayoutLine[] {
  boxes.sort((a, b) => compareBoxes(a, b, budget));
  const rows: Box[][] = [];
  let row: Box[] = [];
  let rowBaseline = 0;
  let rowFont = 0;
  for (const box of boxes) {
    budget.tick();
    const tolerance = round(Math.max(2, Math.max(rowFont, box.fontSize) * 0.65));
    if (row.length > 0 && box.baseline - rowBaseline > tolerance) {
      rows.push(row);
      row = [];
      rowBaseline = 0;
      rowFont = 0;
    }
    row.push(box);
    if (box.fontSize > rowFont || row.length === 1) {
      rowBaseline = box.baseline;
      rowFont = box.fontSize;
    }
  }
  if (row.length > 0) rows.push(row);

  const lines: LayoutLine[] = [];
  for (const rowBoxes of rows) {
    budget.tick();
    rowBoxes.sort((a, b) => {
      budget.tick();
      return a.x0 - b.x0 || a.sourceIndex - b.sourceIndex || a.stableIndex - b.stableIndex;
    });
    let group: Box[] = [];
    let groupX1 = Number.NEGATIVE_INFINITY;
    let groupFont = 0;
    const flush = () => {
      if (group.length === 0) return;
      lines.push(makeLine({ boxes: group, baseline: primaryBaseline(group, budget) }, budget));
      group = [];
      groupX1 = Number.NEGATIVE_INFINITY;
      groupFont = 0;
    };
    for (const box of rowBoxes) {
      budget.tick();
      const gap = box.x0 - groupX1;
      const maximumGap = round(Math.max(pageWidth * 0.1, Math.max(groupFont, box.fontSize) * 4));
      if (box.text.trim().length === 0 && box.x1 - box.x0 > maximumGap) {
        // PDF.js can encode a full column gutter as one whitespace text item.
        // Do not let that empty box bridge the two neighboring text columns.
        flush();
        continue;
      }
      if (group.length > 0 && gap > maximumGap) flush();
      group.push(box);
      groupX1 = Math.max(groupX1, box.x1);
      groupFont = Math.max(groupFont, box.fontSize);
    }
    flush();
  }
  lines.sort((a, b) => {
    budget.tick();
    return a.y - b.y || a.x - b.x || a.sourceIndex - b.sourceIndex;
  });
  return lines;
}

function medianFont(lines: readonly LayoutLine[], budget: Budget): number {
  if (lines.length === 0) return 0;
  const sizes: number[] = [];
  for (const line of lines) {
    budget.tick();
    sizes.push(line.fontSize);
  }
  sizes.sort((a, b) => {
    budget.tick();
    return a - b;
  });
  return sizes[Math.floor(sizes.length / 2)]!;
}

function orderZone(lines: LayoutLine[], pageWidth: number, budget: Budget): LayoutLine[] {
  if (lines.length < 4) return lines;
  const byX: LayoutLine[] = [];
  for (const line of lines) {
    budget.tick();
    byX.push(line);
  }
  byX.sort((a, b) => {
    budget.tick();
    return a.x - b.x || a.y - b.y || a.sourceIndex - b.sourceIndex;
  });
  const threshold = round(Math.max(pageWidth * 0.14, medianFont(lines, budget) * 5));
  const groups: LayoutLine[][] = [];
  let group: LayoutLine[] = [];
  let priorX: number | undefined;
  for (const line of byX) {
    budget.tick();
    if (priorX !== undefined && Math.abs(line.x - priorX) >= threshold) {
      groups.push(group);
      group = [];
    }
    group.push(line);
    priorX = line.x;
  }
  groups.push(group);
  if (groups.length < 2 || groups.length > 3) return lines;
  for (const column of groups) {
    budget.tick();
    if (column.length < 2) return lines;
  }

  const ordered: LayoutLine[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    budget.tick();
    const column = groups[index]!;
    column.sort((a, b) => {
      budget.tick();
      return a.y - b.y || a.sourceIndex - b.sourceIndex;
    });
    for (const line of column) {
      budget.tick();
      ordered.push({ ...line, column: index });
    }
  }
  return ordered;
}

function readingOrder(lines: LayoutLine[], width: number, height: number, budget: Budget): LayoutLine[] {
  const sorted: LayoutLine[] = [];
  for (const line of lines) {
    budget.tick();
    sorted.push(line);
  }
  sorted.sort((a, b) => {
    budget.tick();
    return a.y - b.y || a.x - b.x || a.sourceIndex - b.sourceIndex;
  });
  const footnotes: LayoutLine[] = [];
  const main: LayoutLine[] = [];
  for (const line of sorted) {
    budget.tick();
    if (line.y >= height * 0.9) footnotes.push(line);
    else main.push(line);
  }

  const output: LayoutLine[] = [];
  let zone: LayoutLine[] = [];
  for (const line of main) {
    budget.tick();
    if (line.width >= width * 0.7) {
      for (const ordered of orderZone(zone, width, budget)) {
        budget.tick();
        output.push(ordered);
      }
      zone = [];
      output.push({ ...line, column: -1 });
    } else zone.push(line);
  }
  for (const ordered of orderZone(zone, width, budget)) {
    budget.tick();
    output.push(ordered);
  }
  for (const line of footnotes) {
    budget.tick();
    output.push({ ...line, column: -1 });
  }
  return output;
}

function joinsParagraph(previous: LayoutLine, next: LayoutLine): boolean {
  if (previous.column !== next.column) return false;
  const largerFont = Math.max(previous.fontSize, next.fontSize);
  const smallerFont = Math.min(previous.fontSize, next.fontSize);
  if (smallerFont > 0 && largerFont / smallerFont >= 1.35) return false;
  const gap = next.y - previous.y;
  if (gap > round(largerFont * 1.65)) return false;
  if (/[.!?…:][”’"')\]]?$/u.test(previous.text) && gap > round(largerFont * 1.45)) return false;
  if (Math.abs(next.x - previous.x) > round(largerFont * 1.5)) return false;
  return true;
}

function paragraphText(lines: readonly LayoutLine[], budget: Budget): string {
  const parts: string[] = [];
  let previous: LayoutLine | undefined;
  for (const line of lines) {
    budget.tick();
    if (previous) {
      const first = line.text.charCodeAt(0);
      if (parts[parts.length - 1]!.endsWith('-') && first >= 97 && first <= 122) {
        parts[parts.length - 1] = parts[parts.length - 1]!.slice(0, -1);
        parts.push(line.text);
      } else parts.push(' ', line.text);
    } else parts.push(line.text);
    previous = line;
  }
  return parts.join('');
}

function safePrefix(text: string, maximum: number): string {
  if (maximum >= text.length) return text;
  if (maximum <= 0) return '';
  let length = maximum;
  const last = text.charCodeAt(length - 1);
  const next = text.charCodeAt(length);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) length -= 1;
  return text.slice(0, length);
}

function toParagraphs(lines: LayoutLine[], outlinePresent: boolean, budget: Budget): LayoutParagraph[] {
  const bodySize = medianFont(lines, budget);
  const paragraphs: LayoutParagraph[] = [];
  let current: LayoutLine[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const heading = !outlinePresent && current[0]!.fontSize >= round(bodySize * 1.35);
    paragraphs.push({ text: paragraphText(current, budget), lines: current, heading });
    current = [];
  };
  for (const line of lines) {
    budget.tick();
    const isHeading = !outlinePresent && line.fontSize >= round(bodySize * 1.35);
    const previous = current[current.length - 1];
    const previousIsHeading =
      previous !== undefined && !outlinePresent && previous.fontSize >= round(bodySize * 1.35);
    if (previous && (!joinsParagraph(previous, line) || previousIsHeading || isHeading)) flush();
    current.push(line);
    if (isHeading) flush();
  }
  flush();
  return paragraphs;
}

/**
 * Pure, bounded heuristics for PDF text layout. Geometry is rounded to 0.001pt
 * before stable ordering. This is preparation code: callers must supply the
 * text layer and outline state; it does not parse PDF operators or claim
 * end-to-end reading-order accuracy.
 */
export function layoutPage(
  items: readonly TextItem[],
  page: LayoutPage,
  budget: Budget,
  options: LayoutOptions = {},
): LayoutResult {
  budget.tick();
  let resourceTruncated = false;
  if (budget.canRead) {
    for (const warning of budget.warnings.warnings) {
      budget.tick();
      if (warning.code === 'TRUNCATED') resourceTruncated = true;
    }
  }
  const dimensions = pageDimensions(page);
  if (!dimensions)
    return { page: { width: 0, height: 0 }, lines: [], paragraphs: [], unsupportedDirectionItems: 0 };
  if (!budget.canRead || resourceTruncated)
    return { page: dimensions, lines: [], paragraphs: [], unsupportedDirectionItems: 0 };
  const orientation = analysisRotation(items, budget);
  const hasCanonicalFrame = orientation !== undefined;
  const analysisPage = {
    ...page,
    width: round(page.width),
    height: round(page.height),
    rotation: hasCanonicalFrame ? orientation : page.rotation,
  };
  const analysisDimensions = pageDimensions(analysisPage)!;
  const boxes: Box[] = [];
  const stagedText: TextStage = { used: 0 };
  let unsupportedDirectionItems = 0;
  for (let index = 0; index < items.length; index += 1) {
    budget.tick();
    const input = items[index]!;
    if (input !== null && typeof input === 'object' && input.dir !== 'ltr' && input.dir !== 'rtl') {
      unsupportedDirectionItems += 1;
      continue;
    }
    const box = normalizeItem(input, analysisPage, budget, index);
    if (!box) continue;
    const candidate = stagedText.used + box.text.length + 1;
    if (!budget.checkOutputChars(candidate)) {
      if (!budget.canRead) break;
      const remaining = Math.max(0, budget.limits.outputChars - budget.outputChars - stagedText.used - 1);
      box.text = safePrefix(box.text, remaining);
      if (box.text.length > 0) {
        stagedText.used += box.text.length + 1;
        boxes.push(box);
      }
      break;
    }
    stagedText.used += box.text.length + 1;
    boxes.push(box);
  }
  let lines: LayoutLine[];
  let analyzedLines: LayoutLine[] | undefined;
  if (!hasCanonicalFrame) {
    // Mixed or non-quarter-turn text frames do not have a safe shared baseline.
    // Keep each text item intact and in source order rather than merging it by guesswork.
    lines = [];
    const orderedBoxes = [...boxes];
    orderedBoxes.sort((a, b) => {
      budget.tick();
      return a.sourceIndex - b.sourceIndex || a.stableIndex - b.stableIndex;
    });
    for (const box of orderedBoxes) {
      budget.tick();
      const line = makeLine({ boxes: [box], baseline: box.baseline }, budget);
      if (line.text.length > 0) lines.push(line);
    }
  } else {
    const nonemptyLines: LayoutLine[] = [];
    for (const line of makeLines(boxes, analysisDimensions.width, budget)) {
      budget.tick();
      if (line.text.length > 0) nonemptyLines.push(line);
    }
    analyzedLines = readingOrder(nonemptyLines, analysisDimensions.width, analysisDimensions.height, budget);
    const delta = ((page.rotation - analysisPage.rotation + 360) % 360) as LayoutPage['rotation'];
    const analysisFrame: LayoutPage = {
      width: analysisDimensions.width,
      height: analysisDimensions.height,
      rotation: 0,
    };
    lines = analyzedLines.map((line) => {
      budget.tick();
      return remapLine(line, analysisFrame, delta, budget);
    });
  }
  let paragraphs: LayoutParagraph[];
  if (hasCanonicalFrame) {
    const analyzedParagraphs = toParagraphs(analyzedLines!, options.outlinePresent === true, budget);
    const lineMap = new Map<LayoutLine, LayoutLine>();
    for (let index = 0; index < analyzedLines!.length; index += 1) {
      budget.tick();
      lineMap.set(analyzedLines![index]!, lines[index]!);
    }
    paragraphs = [];
    for (const paragraph of analyzedParagraphs) {
      budget.tick();
      const paragraphLines: LayoutLine[] = [];
      for (const line of paragraph.lines) {
        budget.tick();
        const mapped = lineMap.get(line);
        if (mapped) paragraphLines.push(mapped);
      }
      paragraphs.push({ ...paragraph, lines: paragraphLines });
    }
  } else {
    paragraphs = [];
    for (const line of lines) {
      budget.tick();
      for (const paragraph of toParagraphs([line], options.outlinePresent === true, budget)) {
        budget.tick();
        paragraphs.push(paragraph);
      }
    }
  }
  return {
    page: dimensions,
    lines,
    paragraphs,
    unsupportedDirectionItems,
  };
}

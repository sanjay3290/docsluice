import type { Block, Cell, DocsluiceDocument, ListItem, SectionBlock, TableBlock } from '../core/model.js';
import { Budget } from '../core/budget.js';
import { DEFAULT_LIMITS } from '../core/limits.js';

/** Options for the pure GitHub-flavoured Markdown renderer. */
export interface MarkdownOptions {
  /** Include extracted headers and footers. Defaults to false. */
  headersFooters?: boolean;
  /** Render page, slide, sheet, and part markers. Defaults to `heading`. */
  sections?: 'heading' | 'comment' | 'none';
  /** Render tables as flattened GFM, or use HTML when merges or line breaks need it. */
  tables?: 'flatten' | 'html';
  /** Maximum source rows per table. Defaults to 200. */
  maxTableRows?: number;
  /** Maximum source columns per table. Defaults to 50. */
  maxTableColumns?: number;
}

interface ListFrame {
  items: ListItem[];
  index: number;
  indent: number;
  ordered: boolean;
}

const DEFAULT_MAX_TABLE_ROWS = 200;
const DEFAULT_MAX_TABLE_COLUMNS = 50;
const MAX_PENDING_MARKERS = 4096;

interface RenderContext {
  budget: Budget;
  pendingOutputChars: number;
  /** Leftmost addressed column of the table being rendered; addresses place cells relative to it. */
  columnOrigin?: number;
}

function tick(context: RenderContext): void {
  context.budget.tick();
}

function reserve(context: RenderContext, amount: number): void {
  context.budget.checkOutputChars(context.pendingOutputChars + amount);
  context.pendingOutputChars += amount;
}

function commitOutput(context: RenderContext): void {
  if (context.pendingOutputChars === 0) return;
  context.budget.addOutputChars(context.pendingOutputChars);
  context.pendingOutputChars = 0;
}

function isWhitespace(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r';
}

function asciiLetter(character: string | undefined): boolean {
  return Boolean(
    character && ((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')),
  );
}

function asciiWord(character: string): boolean {
  return (
    (character >= 'a' && character <= 'z') ||
    (character >= 'A' && character <= 'Z') ||
    (character >= '0' && character <= '9')
  );
}

function sourceSyntax(
  text: string,
  context: RenderContext,
  tableCell: boolean,
  comment: boolean,
  linkLabel: boolean,
): Uint8Array {
  // This bitmap uses one byte per already-budget-checked source character. A Set of syntax
  // offsets can consume many times the source size on hostile punctuation-heavy documents.
  const positions = new Uint8Array(text.length);
  const pairedRuns = new Map<string, { length: number; starts: number[] }>();
  const brackets: number[] = [];
  let pendingRuns = 0;
  let escapeMarkersUntilLineEnd = false;
  let escapeBracketsUntilLineEnd = false;
  let inHtmlConstruct = false;

  for (let index = 0; index < text.length;) {
    tick(context);
    const character = text[index]!;
    if (linkLabel && (character === '[' || character === ']')) positions[index] = 1;
    if (character === '\n' || character === '\r') {
      brackets.length = 0;
      escapeBracketsUntilLineEnd = false;
      if (escapeMarkersUntilLineEnd) {
        pairedRuns.clear();
        pendingRuns = 0;
        escapeMarkersUntilLineEnd = false;
      }
      index++;
      continue;
    }
    if (!linkLabel && (character === '[' || character === ']')) {
      if (escapeBracketsUntilLineEnd) {
        positions[index++] = 1;
        continue;
      }
      if (character === '[') {
        if (brackets.length >= MAX_PENDING_MARKERS) {
          for (const opener of brackets) positions[opener] = 1;
          positions[index] = 1;
          brackets.length = 0;
          escapeBracketsUntilLineEnd = true;
        } else {
          brackets.push(index);
        }
        index++;
        continue;
      }
      const opener = brackets.pop();
      const following = text[index + 1];
      if (opener !== undefined && (following === '(' || following === '[' || following === ':')) {
        positions[opener] = 1;
        positions[index] = 1;
        if (opener > 0 && text[opener - 1] === '!') positions[opener - 1] = 1;
      }
      index++;
      continue;
    }
    if (character === '`' || character === '*' || character === '_' || character === '~') {
      const start = index;
      while (index < text.length && text[index] === character) {
        tick(context);
        index++;
      }
      const length = index - start;
      if (character === '~' && length < 2) continue;
      const key = `${character}:${length}`;
      const runState = pairedRuns.get(key) ?? { length, starts: [] };
      const openers = runState.starts;
      const before = start > 0 ? text[start - 1]! : '';
      const after = index < text.length ? text[index]! : '';
      let canOpen = character === '`' || (after !== '' && !isWhitespace(after));
      let canClose = character === '`' || (before !== '' && !isWhitespace(before));
      if (character === '_') {
        canOpen = canOpen && !(asciiWord(before) && asciiWord(after));
        canClose = canClose && !(asciiWord(before) && asciiWord(after));
      }
      if (escapeMarkersUntilLineEnd) {
        for (let cursor = start; cursor < index; cursor++) positions[cursor] = 1;
        continue;
      }
      if (canClose && openers.length > 0) {
        const opener = openers.pop()!;
        pendingRuns--;
        for (let cursor = opener; cursor < opener + length; cursor++) {
          tick(context);
          positions[cursor] = 1;
        }
        for (let cursor = start; cursor < index; cursor++) {
          tick(context);
          positions[cursor] = 1;
        }
      } else if (canOpen) {
        if (pendingRuns >= MAX_PENDING_MARKERS) {
          for (const state of pairedRuns.values()) {
            for (const opener of state.starts) {
              for (let cursor = opener; cursor < opener + state.length; cursor++) positions[cursor] = 1;
            }
          }
          pairedRuns.clear();
          pendingRuns = 0;
          escapeMarkersUntilLineEnd = true;
          for (let cursor = start; cursor < index; cursor++) positions[cursor] = 1;
        } else {
          openers.push(start);
          pendingRuns++;
        }
      }
      if (!escapeMarkersUntilLineEnd && openers.length > 0) pairedRuns.set(key, runState);
      else pairedRuns.delete(key);
      continue;
    }
    if (
      character === '<' &&
      (text[index + 1] === '!' ||
        text[index + 1] === '?' ||
        text[index + 1] === '/' ||
        asciiLetter(text[index + 1]))
    ) {
      // Escape each raw-HTML opener in constant time. Scanning for its `>` from every `<`
      // makes repeated tag prefixes quadratic on hostile source. The lightweight state only
      // escapes the next terminator for readability; safety comes from escaping `<` itself.
      positions[index] = 1;
      inHtmlConstruct = true;
      index++;
      continue;
    }
    if (character === '>' && inHtmlConstruct) {
      positions[index] = 1;
      inHtmlConstruct = false;
    }
    if (tableCell && character === '|') positions[index] = 1;
    if (comment && character === '>' && index >= 2 && text[index - 1] === '-' && text[index - 2] === '-')
      positions[index] = 1;
    index++;
  }

  let lineStart = 0;
  while (lineStart < text.length) {
    tick(context);
    let lineEnd = lineStart;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      tick(context);
      lineEnd++;
    }
    let marker = lineStart;
    while (marker < lineEnd && (text[marker] === ' ' || text[marker] === '\t')) {
      tick(context);
      marker++;
    }
    if (marker - lineStart <= 3 && marker < lineEnd) {
      const first = text[marker]!;
      if (first === '#') {
        let end = marker;
        while (end < lineEnd && text[end] === '#') {
          tick(context);
          end++;
        }
        if (end - marker <= 6 && (end === lineEnd || isWhitespace(text[end]!))) positions[marker] = 1;
      } else if (
        (first === '>' || first === '-' || first === '+' || first === '*') &&
        (marker + 1 === lineEnd || isWhitespace(text[marker + 1]!))
      ) {
        positions[marker] = 1;
      } else if (first === '`' || first === '~') {
        let end = marker;
        while (end < lineEnd && text[end] === first) {
          tick(context);
          end++;
        }
        if (end - marker >= 3) positions[marker] = 1;
      } else if (first === '=') {
        let valid = true;
        for (let cursor = marker; cursor < lineEnd; cursor++) {
          tick(context);
          if (text[cursor] !== '=' && text[cursor] !== ' ' && text[cursor] !== '\t') valid = false;
        }
        if (valid) {
          for (let cursor = marker; cursor < lineEnd; cursor++) {
            tick(context);
            if (text[cursor] === '=') positions[cursor] = 1;
          }
        }
      }

      let digitEnd = marker;
      while (
        digitEnd < lineEnd &&
        digitEnd - marker < 9 &&
        text[digitEnd]! >= '0' &&
        text[digitEnd]! <= '9'
      ) {
        tick(context);
        digitEnd++;
      }
      if (
        digitEnd > marker &&
        digitEnd < lineEnd &&
        (text[digitEnd] === '.' || text[digitEnd] === ')') &&
        (digitEnd + 1 === lineEnd || isWhitespace(text[digitEnd + 1]!))
      ) {
        positions[digitEnd] = 1;
      }
      const breakMarker = text[marker];
      if (breakMarker === '-' || breakMarker === '*' || breakMarker === '_') {
        let count = 0;
        let valid = true;
        for (let cursor = marker; cursor < lineEnd; cursor++) {
          tick(context);
          if (text[cursor] === breakMarker) count++;
          else if (text[cursor] !== ' ' && text[cursor] !== '\t') valid = false;
        }
        if (valid && count >= 3) positions[marker] = 1;
      }
    }

    let indentEnd = lineStart;
    let indentColumns = 0;
    while (indentEnd < lineEnd && (text[indentEnd] === ' ' || text[indentEnd] === '\t')) {
      tick(context);
      indentColumns += text[indentEnd] === '\t' ? 4 : 1;
      indentEnd++;
    }
    if (indentColumns >= 4 && indentEnd < lineEnd) positions[lineStart] = 1;

    let nextStart = lineEnd + 1;
    if (lineEnd < text.length && text[lineEnd] === '\r' && text[lineEnd + 1] === '\n') nextStart++;
    if (nextStart < text.length && tableHeaderLine(text, lineStart, lineEnd, context)) {
      let nextEnd = nextStart;
      while (nextEnd < text.length && text[nextEnd] !== '\n' && text[nextEnd] !== '\r') {
        tick(context);
        nextEnd++;
      }
      if (isTableDelimiter(text, nextStart, nextEnd, context)) {
        for (let cursor = lineStart; cursor < lineEnd; cursor++) {
          tick(context);
          if (text[cursor] === '|') positions[cursor] = 1;
        }
        for (let cursor = nextStart; cursor < nextEnd; cursor++) {
          tick(context);
          if (text[cursor] === '|') positions[cursor] = 1;
        }
      }
    }
    lineStart = lineEnd + 1;
    if (lineEnd < text.length && text[lineEnd] === '\r' && text[lineEnd + 1] === '\n') lineStart++;
  }
  return positions;
}

function tableHeaderLine(text: string, start: number, end: number, context: RenderContext): boolean {
  for (let index = start; index < end; index++) {
    tick(context);
    if (text[index] === '|') return true;
  }
  return false;
}

function isTableDelimiter(text: string, start: number, end: number, context: RenderContext): boolean {
  let pipes = 0;
  let dashes = 0;
  for (let index = start; index < end; index++) {
    tick(context);
    const character = text[index]!;
    if (character === '|') pipes++;
    else if (character === '-') dashes++;
    else if (character !== ':' && character !== ' ' && character !== '\t') return false;
  }
  return pipes > 0 && dashes > 0;
}

function escapeSourceText(
  text: string,
  context: RenderContext,
  tableCell = false,
  comment = false,
  linkLabel = false,
): string {
  context.budget.checkOutputChars(context.pendingOutputChars + text.length);
  const syntax = sourceSyntax(text, context, tableCell, comment, linkLabel);
  let output = '';
  for (let index = 0; index < text.length; index++) {
    tick(context);
    const character = text[index]!;
    if (character === '\n' || character === '\r') {
      reserve(context, 1);
      output += character;
      continue;
    }
    if (character === ' ' && syntax[index] !== 0) {
      reserve(context, 5);
      output += '&#32;';
      continue;
    }
    if (character === '\t' && syntax[index] !== 0) {
      reserve(context, 4);
      output += '&#9;';
      continue;
    }

    let escaped = character;
    switch (character) {
      case '&':
        break;
      case '<':
      case '>':
        if (syntax[index] !== 0) escaped = `&${character === '<' ? 'lt' : 'gt'};`;
        break;
      case '\\':
        if (
          index + 1 === text.length ||
          text[index + 1] === '\n' ||
          text[index + 1] === '\r' ||
          isAsciiPunctuation(text[index + 1]!)
        ) {
          escaped = '\\\\';
        }
        break;
      case '*':
      case '_':
      case '[':
      case ']':
      case '#':
      case '+':
      case '-':
      case '!':
      case '|':
      case '`':
      case '~':
      case '=':
      case '.':
      case ')':
        if (syntax[index] !== 0) escaped = `\\${character}`;
        break;
    }
    reserve(context, escaped.length);
    output += escaped;
  }
  return output;
}

function isAsciiPunctuation(character: string): boolean {
  return (
    (character >= '!' && character <= '/') ||
    (character >= ':' && character <= '@') ||
    (character >= '[' && character <= '`') ||
    (character >= '{' && character <= '~')
  );
}

function trimSourceEnd(text: string, context: RenderContext): string {
  let end = text.length;
  while (end > 0 && isWhitespace(text[end - 1]!)) {
    tick(context);
    end--;
  }
  return text.slice(0, end);
}

function escapeHtml(text: string, context: RenderContext): string {
  context.budget.checkOutputChars(context.pendingOutputChars + text.length);
  let output = '';
  for (let index = 0; index < text.length; index++) {
    tick(context);
    const character = text[index]!;
    switch (text[index]) {
      case '&':
        reserve(context, 5);
        output += '&amp;';
        break;
      case '<':
        reserve(context, 4);
        output += '&lt;';
        break;
      case '>':
        reserve(context, 4);
        output += '&gt;';
        break;
      case '"':
        reserve(context, 6);
        output += '&quot;';
        break;
      case "'":
        reserve(context, 5);
        output += '&#39;';
        break;
      default:
        reserve(context, 1);
        output += character;
    }
  }
  return output;
}

function longestBacktickRun(text: string, context: RenderContext): number {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < text.length; index++) {
    tick(context);
    if (text[index] === '`') {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

function safeFence(text: string, context: RenderContext): string {
  context.budget.checkOutputChars(context.pendingOutputChars + text.length);
  const length = Math.max(3, longestBacktickRun(text, context) + 1);
  context.budget.checkOutputChars(context.pendingOutputChars + length * 2 + text.length + 2);
  return '`'.repeat(length);
}

function safeLanguage(language: string | undefined, context: RenderContext): string {
  if (!language) return '';
  context.budget.checkOutputChars(context.pendingOutputChars + language.length);
  for (let index = 0; index < language.length; index++) {
    tick(context);
    const code = language.charCodeAt(index);
    if (!(
      (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      code === 0x2d ||
      code === 0x5f
    )) {
      return '';
    }
  }
  return language;
}

function safeLinkTarget(target: string, context: RenderContext): string | undefined {
  if (target.length === 0) return undefined;
  let colon = -1;
  for (let index = 0; index < target.length; index++) {
    tick(context);
    const code = target.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f || target[index] === '<' || target[index] === '>') {
      return undefined;
    }
    if (target[index] === ':' && colon < 0) colon = index;
    if (target[index] === '/' || target[index] === '?' || target[index] === '#') break;
  }
  if (colon >= 0) {
    let scheme = '';
    for (let index = 0; index < colon; index++) {
      tick(context);
      const character = target[index]!;
      const code = character.charCodeAt(0);
      if (!(
        (code >= 0x41 && code <= 0x5a) ||
        (code >= 0x61 && code <= 0x7a) ||
        (index > 0 && code >= 0x30 && code <= 0x39) ||
        (index > 0 && (character === '+' || character === '-' || character === '.'))
      )) {
        return undefined;
      }
      scheme += character.toLowerCase();
    }
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto' && scheme !== 'tel') {
      return undefined;
    }
  }

  let output = '';
  for (let index = 0; index < target.length; index++) {
    tick(context);
    const character = target[index]!;
    let encoded: string;
    switch (character) {
      case ' ':
        encoded = '%20';
        break;
      case '"':
        encoded = '%22';
        break;
      case "'":
        encoded = '%27';
        break;
      case '(':
        encoded = '%28';
        break;
      case ')':
        encoded = '%29';
        break;
      case '&':
        encoded = '%26';
        break;
      default:
        encoded = character;
    }
    reserve(context, encoded.length);
    output += encoded;
  }
  return output;
}

function renderInlineCode(text: string, context: RenderContext): string {
  context.budget.checkOutputChars(context.pendingOutputChars + text.length);
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(text, context) + 1));
  const pad =
    text.startsWith('`') || text.endsWith('`') || (text.startsWith(' ') && text.endsWith(' ')) ? ' ' : '';
  reserve(context, fence.length * 2 + pad.length * 2 + text.length);
  return `${fence}${pad}${text}${pad}${fence}`;
}

function renderRuns(
  runs: NonNullable<Extract<Block, { kind: 'paragraph' }>['runs']>,
  context: RenderContext,
): string {
  let output = '';
  for (const run of runs) {
    tick(context);
    const linkLabel = Boolean(run.href);
    let text =
      run.code && !linkLabel
        ? renderInlineCode(run.text, context)
        : escapeSourceText(run.text, context, false, false, linkLabel);
    if (!run.code && run.bold && run.italic) {
      reserve(context, 6);
      text = `***${text}***`;
    } else if (!run.code && run.bold) {
      reserve(context, 4);
      text = `**${text}**`;
    } else if (!run.code && run.italic) {
      reserve(context, 2);
      text = `*${text}*`;
    }
    if (run.href) {
      const target = safeLinkTarget(run.href, context);
      if (target === undefined) {
        reserve(context, 3);
        text = `${text} (${escapeSourceText(run.href, context)})`;
      } else {
        reserve(context, 4);
        text = `[${text}](${target})`;
      }
    }
    output += text;
  }
  return output;
}

function renderList(block: Extract<Block, { kind: 'list' }>, context: RenderContext): string {
  const output: string[] = [];
  const stack: ListFrame[] = [{ items: block.items, index: 0, indent: 0, ordered: block.ordered }];
  context.budget.enterDepth('block');
  while (stack.length > 0) {
    tick(context);
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.items.length) {
      stack.pop();
      context.budget.exitDepth('block');
      continue;
    }
    const index = frame.index++;
    const item = frame.items[index]!;
    tick(context);
    const marker = frame.ordered ? `${index + 1}.` : '-';
    reserve(context, frame.indent + marker.length + 1);
    output.push(`${' '.repeat(frame.indent)}${marker} ${escapeSourceText(item.text, context)}`);
    if (item.items && item.items.length > 0) {
      context.budget.enterDepth('block');
      stack.push({
        items: item.items,
        index: 0,
        indent: frame.indent + marker.length + 1,
        ordered: frame.ordered,
      });
    }
  }
  reserve(context, Math.max(0, output.length - 1));
  return output.join('\n');
}

function addressedColumn(address: string | undefined, context: RenderContext): number | undefined {
  if (!address) return undefined;
  let coordinateStart = 0;
  for (let index = 0; index < address.length; index++) {
    tick(context);
    if (address[index] === '!') coordinateStart = index + 1;
  }

  let index = coordinateStart;
  if (address[index] === '$') index++;
  let column = 0;
  let letters = 0;
  while (index < address.length) {
    tick(context);
    const code = address.charCodeAt(index);
    const upper = code >= 0x61 && code <= 0x7a ? code - 0x20 : code;
    if (upper < 0x41 || upper > 0x5a) break;
    column = column * 26 + upper - 0x40;
    if (!Number.isSafeInteger(column)) return undefined;
    letters++;
    index++;
  }
  if (letters === 0) return undefined;
  if (address[index] === '$') index++;
  let digits = 0;
  while (index < address.length) {
    tick(context);
    const code = address.charCodeAt(index);
    if (code < 0x30 || code > 0x39) break;
    digits++;
    index++;
  }
  return digits > 0 && index === address.length ? column - 1 : undefined;
}

function cellColumn(cell: Cell, arrayIndex: number, context: RenderContext): number {
  const column = addressedColumn(cell.address, context);
  return column === undefined ? arrayIndex : column - (context.columnOrigin ?? 0);
}

/** A table cut from the middle of a sheet (for example at Z90000) starts at its own first column. */
function addressOrigin(table: TableBlock, context: RenderContext): number {
  let origin: number | undefined;
  for (const row of table.rows) {
    tick(context);
    for (const cell of row) {
      tick(context);
      const column = addressedColumn(cell.address, context);
      if (column !== undefined && (origin === undefined || column < origin)) origin = column;
    }
  }
  return origin ?? 0;
}

interface PositionedCell {
  cell: Cell;
  column: number;
  sourceIndex: number;
}

function positionedCells(row: Cell[], visibleColumns: number, context: RenderContext): PositionedCell[] {
  const positioned: PositionedCell[] = [];
  for (let index = 0; index < row.length; index++) {
    tick(context);
    const cell = row[index]!;
    const column = cellColumn(cell, index, context);
    if (column < visibleColumns) positioned.push({ cell, column, sourceIndex: index });
  }
  positioned.sort((left, right) => {
    tick(context);
    return left.column - right.column || left.sourceIndex - right.sourceIndex;
  });

  const occupied = new Set<number>();
  const unique: PositionedCell[] = [];
  for (const entry of positioned) {
    tick(context);
    let column = entry.column;
    if (occupied.has(column)) {
      // Repeated addresses cannot describe two physical cells. Fall back to the source
      // position for the later entry so its text is kept without shifting an earlier address.
      column = entry.sourceIndex;
      while (column < visibleColumns && occupied.has(column)) {
        tick(context);
        column++;
      }
    }
    if (column >= visibleColumns) continue;
    occupied.add(column);
    unique.push({ ...entry, column });
  }
  unique.sort((left, right) => {
    tick(context);
    return left.column - right.column || left.sourceIndex - right.sourceIndex;
  });
  return unique;
}

function tableWidth(table: TableBlock, context: RenderContext): number {
  let width = 0;
  for (const row of table.rows) {
    tick(context);
    if (row.length > width) width = row.length;
    for (let index = 0; index < row.length; index++) {
      tick(context);
      const cell = row[index]!;
      const column = cellColumn(cell, index, context);
      const span = normalizedSpan(cell.colSpan, Number.MAX_SAFE_INTEGER - column);
      width = Math.max(width, column + span);
    }
  }
  return width;
}

function tableNeedsHtml(
  table: TableBlock,
  visibleRows: number,
  visibleColumns: number,
  context: RenderContext,
): boolean {
  let needsHtml = false;
  for (let rowIndex = 0; rowIndex < visibleRows; rowIndex++) {
    tick(context);
    const row = table.rows[rowIndex]!;
    for (let index = 0; index < row.length; index++) {
      tick(context);
      const cell = row[index]!;
      const column = cellColumn(cell, index, context);
      if (column >= visibleColumns) continue;
      context.budget.addCells(1);
      context.budget.checkOutputChars(context.pendingOutputChars + cell.text.length);
      if (
        normalizedSpan(cell.rowSpan, visibleRows - rowIndex) > 1 ||
        normalizedSpan(cell.colSpan, visibleColumns - column) > 1 ||
        containsLineBreak(cell.text, context)
      )
        needsHtml = true;
    }
  }
  return needsHtml;
}

function containsLineBreak(text: string, context: RenderContext): boolean {
  for (let index = 0; index < text.length; index++) {
    tick(context);
    if (text[index] === '\n' || text[index] === '\r') return true;
  }
  return false;
}

function cellText(cell: Cell, html: boolean, context: RenderContext): string {
  context.budget.checkOutputChars(context.pendingOutputChars + cell.text.length);
  let output = '';
  let line = '';
  for (let index = 0; index < cell.text.length; index++) {
    tick(context);
    const character = cell.text[index]!;
    if (character === '\r' || character === '\n') {
      if (character === '\r' && cell.text[index + 1] === '\n') {
        tick(context);
        index++;
      }
      output += html ? `${escapeHtml(line, context)}<br>` : `${escapeSourceText(line, context, true)}<br>`;
      reserve(context, 4);
      line = '';
    } else {
      line += character;
    }
  }
  output += html ? escapeHtml(line, context) : escapeSourceText(line, context, true);
  return output;
}

function normalizedSpan(value: number | undefined, remaining: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, remaining);
}

function flattenRows(
  table: TableBlock,
  visibleRows: number,
  visibleColumns: number,
  context: RenderContext,
): string[][] {
  const rows: string[][] = [];
  const coveredUntil: number[] = [];
  for (let rowIndex = 0; rowIndex < visibleRows; rowIndex++) {
    tick(context);
    const row = table.rows[rowIndex]!;
    const values: string[] = [];
    for (let column = 0; column < visibleColumns; column++) {
      tick(context);
      values.push('');
    }
    for (const { cell, column } of positionedCells(row, visibleColumns, context)) {
      tick(context);
      if ((coveredUntil[column] ?? -1) >= rowIndex) continue;
      values[column] = cellText(cell, false, context);
      const colSpan = normalizedSpan(cell.colSpan, visibleColumns - column);
      const rowSpan = normalizedSpan(cell.rowSpan, table.rows.length - rowIndex);
      if (rowSpan > 1) {
        coveredUntil[column] = Math.max(coveredUntil[column] ?? -1, rowIndex + rowSpan - 1);
      }
      for (let covered = column + 1; covered < column + colSpan; covered++) {
        tick(context);
        coveredUntil[covered] = Math.max(coveredUntil[covered] ?? -1, rowIndex + rowSpan - 1);
      }
    }
    rows.push(values);
  }
  return rows;
}

function pipeTable(rows: string[][], headerRows: number, context: RenderContext): string {
  if (rows.length === 0) return '';
  const output: string[] = [];
  const width = rows[0]!.length;
  const header: string[] = [];
  if (headerRows > 0) {
    for (const cell of rows[0]!) {
      tick(context);
      header.push(cell);
    }
  } else {
    for (let index = 0; index < width; index++) {
      tick(context);
      header.push('');
    }
  }
  reserve(context, 4 + Math.max(0, width - 1) * 3);
  output.push(`| ${header.join(' | ')} |`);
  const separator: string[] = [];
  for (let index = 0; index < width; index++) {
    tick(context);
    separator.push('---');
  }
  reserve(context, 4 + Math.max(0, width - 1) * 3 + width * 3);
  output.push(`| ${separator.join(' | ')} |`);
  const firstBody = headerRows > 0 ? 1 : 0;
  for (let index = firstBody; index < rows.length; index++) {
    tick(context);
    reserve(context, 4 + Math.max(0, width - 1) * 3);
    output.push(`| ${rows[index]!.join(' | ')} |`);
  }
  reserve(context, Math.max(0, output.length - 1));
  return output.join('\n');
}

function checkPipeTableStructure(
  rowCount: number,
  columnCount: number,
  headerRows: number,
  context: RenderContext,
): void {
  if (rowCount === 0) return;
  const lineChars = 4 + Math.max(0, columnCount - 1) * 3;
  const separatorChars = lineChars + columnCount * 3;
  const bodyRows = headerRows > 0 ? Math.max(0, rowCount - 1) : rowCount;
  const lineCount = 2 + bodyRows;
  const structuralChars = lineChars + separatorChars + bodyRows * lineChars + lineCount - 1;
  context.budget.checkOutputChars(context.pendingOutputChars + structuralChars);
}

function htmlTable(
  table: TableBlock,
  visibleRows: number,
  visibleColumns: number,
  context: RenderContext,
): string {
  const headerCount = Math.min(Math.max(0, table.headerRows), visibleRows);
  const output = ['<table>', '<tbody>'];
  reserve(context, 14);
  const coveredUntil: number[] = [];

  for (let rowIndex = 0; rowIndex < visibleRows; rowIndex++) {
    tick(context);
    const cells: string[] = [];
    const row = table.rows[rowIndex]!;
    let nextColumn = 0;
    for (const { cell, column } of positionedCells(row, visibleColumns, context)) {
      tick(context);
      while (nextColumn < column) {
        tick(context);
        if ((coveredUntil[nextColumn] ?? -1) < rowIndex) {
          const emptyTag = rowIndex < headerCount ? 'th' : 'td';
          reserve(context, emptyTag.length * 2 + 5);
          cells.push(`<${emptyTag}></${emptyTag}>`);
        }
        nextColumn++;
      }
      if ((coveredUntil[column] ?? -1) >= rowIndex) {
        nextColumn = Math.max(nextColumn, column + 1);
        continue;
      }
      const colSpan = normalizedSpan(cell.colSpan, visibleColumns - column);
      const rowSpan = normalizedSpan(cell.rowSpan, visibleRows - rowIndex);
      for (let covered = column; covered < column + colSpan; covered++) {
        tick(context);
        if (rowSpan > 1)
          coveredUntil[covered] = Math.max(coveredUntil[covered] ?? -1, rowIndex + rowSpan - 1);
        else if (covered > column) coveredUntil[covered] = rowIndex;
      }
      const tag = rowIndex < headerCount ? 'th' : 'td';
      const attrs = `${rowSpan > 1 ? ` rowspan="${rowSpan}"` : ''}${colSpan > 1 ? ` colspan="${colSpan}"` : ''}`;
      reserve(context, tag.length * 2 + 5 + attrs.length);
      cells.push(`<${tag}${attrs}>${cellText(cell, true, context)}</${tag}>`);
      nextColumn = Math.max(nextColumn, column + colSpan);
    }
    reserve(context, 9);
    output.push(`<tr>${cells.join('')}</tr>`);
  }
  reserve(context, 16);
  output.push('</tbody>');
  output.push('</table>');
  reserve(context, Math.max(0, output.length - 1));
  return output.join('\n');
}

function validCap(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('Markdown table limits must be nonnegative safe integers.');
  }
  return value;
}

function renderTable(table: TableBlock, options: MarkdownOptions, context: RenderContext): string {
  const maxRows = validCap(options.maxTableRows, DEFAULT_MAX_TABLE_ROWS);
  const maxColumns = validCap(options.maxTableColumns, DEFAULT_MAX_TABLE_COLUMNS);
  context.columnOrigin = addressOrigin(table, context);
  const width = tableWidth(table, context);
  const visibleRows = Math.min(table.rows.length, maxRows);
  const visibleColumns = Math.min(width, maxColumns);
  const needsHtml = tableNeedsHtml(table, visibleRows, visibleColumns, context);
  const html = options.tables === 'html' && needsHtml;
  const output: string[] = [];
  if (table.caption) output.push(escapeSourceText(table.caption, context));
  if (html) output.push(htmlTable(table, visibleRows, visibleColumns, context));
  else {
    checkPipeTableStructure(visibleRows, visibleColumns, table.headerRows, context);
    output.push(
      pipeTable(flattenRows(table, visibleRows, visibleColumns, context), table.headerRows, context),
    );
  }

  const omittedRows = table.rows.length - visibleRows;
  const omittedColumns = width - visibleColumns;
  if (omittedRows > 0 || omittedColumns > 0) {
    const omissions: string[] = [];
    if (omittedRows > 0) omissions.push(`${omittedRows} more ${omittedRows === 1 ? 'row' : 'rows'}`);
    if (omittedColumns > 0)
      omissions.push(`${omittedColumns} more ${omittedColumns === 1 ? 'column' : 'columns'}`);
    const omission = `… ${omissions.join(' and ')} not shown`;
    reserve(context, omission.length);
    output.push(omission);
  }
  const nonempty = output.filter(Boolean);
  reserve(context, Math.max(0, nonempty.length - 1) * 2);
  return nonempty.join('\n\n');
}

function sectionLabel(section: SectionBlock, context: RenderContext): string | undefined {
  switch (section.role) {
    case 'page':
      return trimSourceEnd(`Page ${section.loc.page ?? section.loc.pageLabel ?? ''}`, context);
    case 'slide':
      return trimSourceEnd(
        `Slide ${section.loc.slide ?? ''}${section.title ? `: ${section.title}` : ''}`,
        context,
      );
    case 'sheet':
      return trimSourceEnd(`Sheet: ${section.loc.sheet ?? section.title ?? ''}`, context);
    case 'part':
      return `Part${section.title ? `: ${section.title}` : ''}`;
  }
  tick(context);
}

function sectionMarker(
  section: SectionBlock,
  style: MarkdownOptions['sections'],
  context: RenderContext,
): string {
  if (style === 'none') return '';
  const label = sectionLabel(section, context);
  if (!label) return '';
  const safeLabel = escapeSourceText(label, context, false, style === 'comment');
  if (style === 'comment') {
    reserve(context, 9);
    return `<!-- ${safeLabel} -->`;
  }
  reserve(context, 3);
  return `## ${safeLabel}`;
}

function renderBlock(block: Block, options: MarkdownOptions, context: RenderContext): string {
  tick(context);
  switch (block.kind) {
    case 'heading': {
      const level = Number.isInteger(block.level) ? Math.max(1, Math.min(6, block.level)) : 1;
      reserve(context, level + 1);
      return `${'#'.repeat(level)} ${escapeSourceText(block.text, context)}`;
    }
    case 'paragraph':
      return block.runs ? renderRuns(block.runs, context) : escapeSourceText(block.text, context);
    case 'list':
      return renderList(block, context);
    case 'table':
      return renderTable(block, options, context);
    case 'code': {
      const fence = safeFence(block.text, context);
      const language = safeLanguage(block.language, context);
      reserve(context, fence.length * 2 + language.length + 2 + block.text.length);
      return `${fence}${language}\n${block.text}\n${fence}`;
    }
    case 'image': {
      const alt = escapeSourceText(block.alt ?? '', context, false, false, true);
      const target = block.ref ? safeLinkTarget(block.ref, context) : undefined;
      if (target === undefined) {
        if (!block.ref) return alt;
        reserve(context, 3);
        return `${alt} (${escapeSourceText(block.ref, context)})`;
      }
      reserve(context, 5);
      return `![${alt}](${target})`;
    }
    case 'note': {
      const role = escapeSourceText(block.role, context);
      const noteText = escapeSourceText(block.text, context);
      let quoted = '';
      for (let index = 0; index < noteText.length; index++) {
        tick(context);
        if (noteText[index] === '\n') {
          reserve(context, 3);
          quoted += '\n> ';
        } else {
          quoted += noteText[index];
        }
      }
      reserve(context, 11 + role.length);
      return `> Note (${role}): ${quoted}`;
    }
    case 'header':
    case 'footer':
      if (!options.headersFooters) return '';
      reserve(context, 8);
      return `${block.kind === 'header' ? 'Header' : 'Footer'}: ${escapeSourceText(block.text, context)}`;
    case 'section':
      return sectionMarker(block, options.sections ?? 'heading', context);
  }
}

/**
 * Render a document as safe GitHub-flavoured Markdown.
 * Source text is escaped at Markdown boundaries; raw HTML and unsafe link schemes remain inert.
 * Lists and section trees are traversed iteratively so renderer nesting does not use the JS call stack.
 * Each render uses the default internal block-depth, cell, output-character, and time limits.
 * A limit error is thrown instead of returning partial Markdown.
 */
export function toMarkdown(doc: DocsluiceDocument, options: MarkdownOptions = {}): string {
  return renderMarkdown(doc, options, new Budget(DEFAULT_LIMITS, { onLimit: 'throw' }));
}

function renderMarkdown(doc: DocsluiceDocument, options: MarkdownOptions, budget: Budget): string {
  const context: RenderContext = { budget, pendingOutputChars: 0 };
  const output: string[] = [];
  const activeArrays = new WeakSet<Block[]>();
  activeArrays.add(doc.blocks);
  const stack: Array<{ blocks: Block[]; index: number; entered: boolean }> = [
    { blocks: doc.blocks, index: 0, entered: false },
  ];
  while (stack.length > 0) {
    tick(context);
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.blocks.length) {
      stack.pop();
      activeArrays.delete(frame.blocks);
      if (frame.entered) budget.exitDepth('block');
      continue;
    }
    const block = frame.blocks[frame.index++]!;
    if (block.kind === 'section') {
      const marker = sectionMarker(block, options.sections ?? 'heading', context);
      if (marker) appendSegment(output, marker, context);
      if (activeArrays.has(block.blocks)) throw new TypeError('Document blocks must not contain cycles.');
      budget.enterDepth('block');
      activeArrays.add(block.blocks);
      stack.push({ blocks: block.blocks, index: 0, entered: true });
      continue;
    }
    const rendered = renderBlock(block, options, context);
    if (rendered) appendSegment(output, rendered, context);
    else commitOutput(context);
  }
  commitOutput(context);
  return output.join('\n\n');
}

function appendSegment(output: string[], segment: string, context: RenderContext): void {
  if (output.length > 0) reserve(context, 2);
  output.push(segment);
  commitOutput(context);
}

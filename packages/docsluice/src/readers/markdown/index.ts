import type { Cell, ListItem, Run } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';

interface Marker {
  indent: number;
  ordered: boolean;
  marker: string;
  textStart: number;
}

function marker(line: string, budget: ReadContext['budget']): Marker | undefined {
  let indent = 0;
  while (indent < line.length && line.charCodeAt(indent) === 0x20) {
    budget.tick();
    indent++;
  }
  const first = line[indent];
  if (first === '-' || first === '*' || first === '+') {
    if (line[indent + 1] === ' ' || line[indent + 1] === '\t')
      return { indent, ordered: false, marker: first, textStart: indent + 2 };
  }
  let cursor = indent;
  while (
    cursor < line.length &&
    cursor - indent < 9 &&
    line.charCodeAt(cursor) >= 0x30 &&
    line.charCodeAt(cursor) <= 0x39
  ) {
    budget.tick();
    cursor++;
  }
  if (
    cursor > indent &&
    (line[cursor] === '.' || line[cursor] === ')') &&
    (line[cursor + 1] === ' ' || line[cursor + 1] === '\t')
  )
    return { indent, ordered: true, marker: line.slice(indent, cursor + 1), textStart: cursor + 2 };
  return undefined;
}

function atxHeading(
  line: string,
  budget: ReadContext['budget'],
): { level: number; start: number; end: number } | undefined {
  let cursor = 0;
  while (cursor < line.length && cursor < 4 && line[cursor] === ' ') {
    budget.tick();
    cursor++;
  }
  if (cursor > 3 || line[cursor] !== '#') return undefined;
  const start = cursor;
  while (line[cursor] === '#' && cursor - start < 6) {
    budget.tick();
    cursor++;
  }
  if (line[cursor] === '#') return undefined;
  const level = cursor - start;
  if (cursor < line.length && line[cursor] !== ' ' && line[cursor] !== '\t') return undefined;
  while (line[cursor] === ' ' || line[cursor] === '\t') cursor++;
  let end = line.length;
  while (end > cursor && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  let hashes = end;
  while (hashes > cursor && line[hashes - 1] === '#') hashes--;
  if (hashes < end && hashes > cursor && (line[hashes - 1] === ' ' || line[hashes - 1] === '\t')) {
    end = hashes;
    while (end > cursor && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  }
  return { level, start: cursor, end };
}

function stripInline(
  source: string,
  runs: boolean,
  budget: ReadContext['budget'],
  maximum = Math.max(0, budget.limits.outputChars - budget.outputChars),
  rangeStart = 0,
  rangeEnd = source.length,
): { text: string; runs?: Run[]; truncated: boolean } {
  let text = '';
  const resultRuns: Run[] = [];
  let truncated = false;
  let imageAltPending = false;
  const add = (value: string, href?: string): void => {
    if (text.length + value.length > maximum) {
      const part = value.slice(0, Math.max(0, maximum - text.length));
      text += part;
      if (runs && part.length > 0) resultRuns.push(href ? { text: part, href } : { text: part });
      truncated = true;
      return;
    }
    text += value;
    if (runs && value.length > 0) resultRuns.push(href ? { text: value, href } : { text: value });
  };
  const addRange = (start: number, end: number, href?: string): void => {
    const remaining = Math.max(0, maximum - text.length);
    add(source.slice(start, Math.min(end, start + remaining + 1)), href);
  };
  while (rangeStart < rangeEnd && (source[rangeStart] === ' ' || source[rangeStart] === '\t')) {
    budget.tick();
    rangeStart++;
  }
  while (rangeEnd > rangeStart && (source[rangeEnd - 1] === ' ' || source[rangeEnd - 1] === '\t')) {
    budget.tick();
    rangeEnd--;
  }
  for (let i = rangeStart; i < rangeEnd;) {
    budget.tick();
    if (truncated) break;
    if (source[i] === '\\' && i + 1 < rangeEnd) {
      add(source[i + 1]!);
      i += 2;
      continue;
    }
    if (source[i] === '!' && source[i + 1] === '[') {
      imageAltPending = true;
      i++;
      continue;
    }
    if (source[i] === '[') {
      const imageAlt = imageAltPending;
      imageAltPending = false;
      let labelEnd = i + 1;
      while (labelEnd < rangeEnd && source[labelEnd] !== ']' && source[labelEnd] !== '[') {
        budget.tick();
        labelEnd++;
      }
      if (labelEnd >= rangeEnd) {
        addRange(i, rangeEnd);
        break;
      }
      if (source[labelEnd] === '[') {
        add(source[i]!);
        i++;
        continue;
      }
      if (source[labelEnd + 1] === '(') {
        let depth = 1;
        let closeParen = labelEnd + 2;
        while (closeParen < rangeEnd && depth > 0) {
          budget.tick();
          if (source[closeParen] === '(') depth++;
          else if (source[closeParen] === ')') depth--;
          closeParen++;
        }
        if (depth === 0) {
          let target = '';
          if (runs) {
            let targetEnd = labelEnd + 2;
            while (
              targetEnd < closeParen - 1 &&
              source[targetEnd] !== ' ' &&
              source[targetEnd] !== '\t' &&
              targetEnd - (labelEnd + 2) < 2048
            ) {
              budget.tick();
              targetEnd++;
            }
            target = source.slice(labelEnd + 2, targetEnd);
          }
          addRange(i + 1, labelEnd, imageAlt ? undefined : target);
          i = closeParen;
          continue;
        }
        addRange(i, rangeEnd);
        break;
      }
      addRange(i, labelEnd + 1);
      i = labelEnd + 1;
      continue;
    }
    if (source[i] === '`') {
      let ticks = 0;
      while (source[i + ticks] === '`') {
        budget.tick();
        ticks++;
      }
      let cursor = i + ticks;
      let closing = -1;
      while (cursor < rangeEnd) {
        budget.tick();
        if (source[cursor] !== '`') {
          cursor++;
          continue;
        }
        let run = 0;
        while (source[cursor + run] === '`') {
          budget.tick();
          run++;
        }
        if (run === ticks) {
          closing = cursor;
          break;
        }
        cursor += run;
      }
      if (closing < 0) {
        addRange(i, rangeEnd);
        break;
      }
      addRange(i + ticks, closing);
      i = closing + ticks;
      continue;
    }
    if (source[i] === '*' || source[i] === '_' || source[i] === '~') {
      i++;
      continue;
    }
    if (source[i] === '<') {
      let close = i + 1;
      while (close < rangeEnd && source[close] !== '>') {
        budget.tick();
        close++;
      }
      if (close >= rangeEnd) {
        addRange(i, rangeEnd);
        break;
      }
      let hasScheme = false;
      for (let scan = i + 1; scan < close; scan++) {
        budget.tick();
        if (source[scan] === ':') {
          hasScheme = true;
          break;
        }
      }
      if (hasScheme) i = close + 1;
      else {
        addRange(i, close + 1);
        i = close + 1;
      }
      continue;
    }
    add(source[i]!);
    if (truncated) break;
    i++;
  }
  return runs ? { text, runs: resultRuns, truncated } : { text, truncated };
}

interface TableState {
  textChars: number;
  stopped: boolean;
}

function splitTableRow(
  line: string,
  ctx: ReadContext,
  state: TableState,
): { cells: Cell[]; complete: boolean } {
  const cells: Cell[] = [];
  let start = 0;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) {
    ctx.budget.tick();
    start++;
  }
  if (line[start] === '|') start++;
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    ctx.budget.tick();
    end--;
  }
  const hasTrailingPipe = line[end - 1] === '|';
  let cellStart = start;
  let escaped = false;
  const push = (rawStart: number, rawEnd: number): boolean => {
    if (!ctx.budget.addCells(1)) {
      state.stopped = true;
      return false;
    }
    while (rawStart < rawEnd && (line[rawStart] === ' ' || line[rawStart] === '\t')) {
      ctx.budget.tick();
      rawStart++;
    }
    while (rawEnd > rawStart && (line[rawEnd - 1] === ' ' || line[rawEnd - 1] === '\t')) {
      ctx.budget.tick();
      rawEnd--;
    }
    const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars - state.textChars);
    const parsed = stripInline(line, false, ctx.budget, remaining, rawStart, rawEnd);
    state.textChars += parsed.text.length;
    cells.push({ text: parsed.text });
    if (parsed.truncated) {
      ctx.budget.checkOutputChars(
        state.textChars +
          Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars - state.textChars) +
          1,
      );
      state.stopped = true;
      return false;
    }
    return true;
  };
  for (let i = start; i < end; i++) {
    ctx.budget.tick();
    if (escaped) {
      escaped = false;
      continue;
    }
    if (line[i] === '\\') {
      escaped = true;
      continue;
    }
    if (line[i] === '|') {
      if (!push(cellStart, i)) break;
      cellStart = i + 1;
    }
  }
  if (!hasTrailingPipe && !state.stopped) push(cellStart, end);
  return { cells, complete: !state.stopped };
}

function isSeparator(line: string, budget: ReadContext['budget']): boolean {
  let start = 0;
  while (start < line.length && (line[start] === ' ' || line[start] === '\t')) {
    budget.tick();
    start++;
  }
  let end = line.length;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) {
    budget.tick();
    end--;
  }
  if (line[start] === '|') start++;
  if (line[end - 1] === '|') end--;
  let cells = 0;
  let cellStart = start;
  for (let index = start; index <= end; index++) {
    budget.tick();
    if (index !== end && line[index] !== '|') continue;
    let left = cellStart;
    let right = index;
    while (left < right && (line[left] === ' ' || line[left] === '\t')) {
      budget.tick();
      left++;
    }
    while (right > left && (line[right - 1] === ' ' || line[right - 1] === '\t')) {
      budget.tick();
      right--;
    }
    if (line[left] === ':') left++;
    if (line[right - 1] === ':') right--;
    let dashes = 0;
    while (left < right && line[left] === '-') {
      budget.tick();
      left++;
      dashes++;
    }
    if (dashes < 3 || left !== right) return false;
    cells++;
    cellStart = index + 1;
  }
  return cells > 0;
}

function emitParagraph(ctx: ReadContext, text: string, inlineRuns?: Run[], sourceTruncated = false): boolean {
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  if (text.length > remaining || sourceTruncated) {
    ctx.budget.checkOutputChars(Math.max(text.length, remaining + 1));
    if (remaining > 0) {
      let left = remaining;
      const clipped: Run[] = [];
      for (const run of inlineRuns ?? []) {
        ctx.budget.tick();
        if (left <= 0) break;
        const part = run.text.slice(0, left);
        if (part.length > 0) clipped.push({ text: part, ...(run.href ? { href: run.href } : {}) });
        left -= part.length;
      }
      ctx.out.paragraph(
        text.slice(0, remaining),
        ctx.path ? { path: ctx.path } : {},
        inlineRuns ? clipped : undefined,
      );
    }
    return false;
  }
  return ctx.out.paragraph(text, ctx.path ? { path: ctx.path } : {}, inlineRuns);
}

function warnDepth(ctx: ReadContext): void {
  ctx.warnings.add({
    code: 'DEPTH_LIMIT',
    message: `Markdown nesting was flattened at the configured block depth of ${ctx.budget.limits.blockDepth}.`,
  });
}

function appendCodeLine(ctx: ReadContext, lines: string[], line: string, size: { chars: number }): boolean {
  const separator = lines.length > 0 ? 1 : 0;
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars - size.chars);
  if (separator + line.length > remaining) {
    if (separator > 0 && remaining > 0) {
      lines.push('');
      size.chars++;
    }
    const available = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars - size.chars);
    if (available > 0) {
      lines.push(line.slice(0, available));
      size.chars += available;
    }
    ctx.budget.checkOutputChars(size.chars + 1);
    return false;
  }
  lines.push(line);
  size.chars += separator + line.length;
  return true;
}

function emitCodeBuffer(ctx: ReadContext, lines: string[], language?: string): boolean {
  return ctx.out.code(lines.join('\n'), ctx.path ? { path: ctx.path } : {}, language);
}

function emitHeading(
  ctx: ReadContext,
  level: 1 | 2 | 3 | 4 | 5 | 6,
  value: { text: string; truncated: boolean },
): boolean {
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  if (value.text.length > remaining || value.truncated) {
    ctx.budget.checkOutputChars(Math.max(value.text.length, remaining + 1));
    if (remaining > 0)
      ctx.out.heading(level, value.text.slice(0, remaining), ctx.path ? { path: ctx.path } : {});
    return false;
  }
  return ctx.out.heading(level, value.text, ctx.path ? { path: ctx.path } : {});
}

/** Best-effort Markdown block reader with bounded scanning and no dependencies. */
export const markdownReader: Reader = {
  id: 'markdown',
  mimeTypes: ['text/markdown', 'text/x-markdown'],
  async read(ctx): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const runs = ctx.options.runs;
    let depthWarned = false;
    const noteDepth = (): void => {
      if (depthWarned) return;
      warnDepth(ctx);
      depthWarned = true;
    };
    let i = 0;
    let steps = 0;
    while (i < lines.length) {
      ctx.budget.tick();
      // A streaming consumer can apply backpressure between blocks (EXT-2).
      if (++steps % 256 === 0) await ctx.out.flush();
      const line = lines[i]!;
      if (line.trim().length === 0) {
        i++;
        continue;
      }
      const atx = atxHeading(line, ctx.budget);
      if (atx) {
        if (
          !emitHeading(
            ctx,
            atx.level as 1 | 2 | 3 | 4 | 5 | 6,
            stripInline(line, runs, ctx.budget, undefined, atx.start, atx.end),
          )
        )
          return;
        i++;
        continue;
      }
      if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]!)) {
        if (
          !emitHeading(ctx, lines[i + 1]!.trimStart()[0] === '=' ? 1 : 2, stripInline(line, runs, ctx.budget))
        )
          return;
        i += 2;
        continue;
      }
      if (/^ {0,3}(?:`{3,}|~{3,})/.test(line)) {
        const opening = line.trimStart();
        const fence = opening[0]!;
        let n = 0;
        while (opening[n] === fence) {
          ctx.budget.tick();
          n++;
        }
        const language = opening.slice(n).trim().split(/[ \t]/, 1)[0];
        const content: string[] = [];
        const size = { chars: 0 };
        i++;
        while (i < lines.length) {
          ctx.budget.tick();
          const candidate = lines[i]!;
          const trimmed = candidate.trimStart();
          let close = 0;
          while (trimmed[close] === fence) {
            ctx.budget.tick();
            close++;
          }
          if (close >= n && trimmed.slice(close).trim() === '') {
            i++;
            break;
          }
          if (!appendCodeLine(ctx, content, candidate, size)) {
            emitCodeBuffer(ctx, content, language || undefined);
            return;
          }
          i++;
        }
        if (!emitCodeBuffer(ctx, content, language || undefined)) return;
        continue;
      }
      if (/^ {4}/.test(line)) {
        const content: string[] = [];
        const size = { chars: 0 };
        while (i < lines.length && (/^ {4}/.test(lines[i]!) || lines[i]!.trim() === '')) {
          ctx.budget.tick();
          if (!appendCodeLine(ctx, content, lines[i]!.trim() === '' ? '' : lines[i]!.slice(4), size)) {
            emitCodeBuffer(ctx, content);
            return;
          }
          i++;
        }
        while (content.at(-1) === '') content.pop();
        if (!emitCodeBuffer(ctx, content)) return;
        continue;
      }
      const firstMarker = marker(line, ctx.budget);
      if (firstMarker) {
        const roots: ListItem[] = [];
        const stack: Array<{ indent: number; item: ListItem }> = [];
        const baseIndent = firstMarker.indent;
        const maxDepth = ctx.budget.limits.blockDepth;
        let stagedChars = 0;
        let listTruncated = false;
        while (i < lines.length) {
          ctx.budget.tick();
          const current = marker(lines[i]!, ctx.budget);
          if (!current) break;
          if (current.indent < baseIndent) break;
          if (current.indent === baseIndent && current.ordered !== firstMarker.ordered) break;
          // The parent is the nearest item indented at least two columns less, so skipped levels leave no gaps.
          while (stack.length > 0 && current.indent < stack.at(-1)!.indent + 2) {
            ctx.budget.tick();
            stack.pop();
          }
          if (!ctx.budget.addCells(1)) {
            listTruncated = true;
            break;
          }
          const totalRemaining = Math.max(
            0,
            ctx.budget.limits.outputChars - ctx.budget.outputChars - stagedChars,
          );
          const markerText = current.marker.slice(0, totalRemaining);
          const available = Math.max(0, totalRemaining - markerText.length);
          const parsed = stripInline(lines[i]!, runs, ctx.budget, available, current.textStart);
          const item: ListItem = {
            text: parsed.text,
            marker: markerText,
          };
          stagedChars += parsed.text.length + markerText.length;
          // Items deeper than `blockDepth` attach to the deepest allowed parent.
          const depth = stack.length + 1;
          if (depth > maxDepth) noteDepth();
          const parent = stack[Math.min(depth, maxDepth) - 2];
          if (parent) (parent.item.items ??= []).push(item);
          else roots.push(item);
          stack.push({ indent: current.indent, item });
          i++;
          if (
            parsed.truncated ||
            markerText.length !== current.marker.length ||
            stagedChars > ctx.budget.limits.outputChars - ctx.budget.outputChars
          ) {
            ctx.budget.checkOutputChars(stagedChars + 1);
            listTruncated = true;
            break;
          }
        }
        const ordered = firstMarker.ordered;
        if (!ctx.out.list(ordered, roots, ctx.path ? { path: ctx.path } : {})) return;
        if (listTruncated) return;
        continue;
      }
      if (/^ {0,3}>/.test(line)) {
        const quote: string[] = [];
        while (i < lines.length && /^ {0,3}>/.test(lines[i]!)) {
          ctx.budget.tick();
          const current = lines[i]!;
          let cursor = 0;
          while (cursor < current.length && current[cursor] === ' ') {
            ctx.budget.tick();
            cursor++;
          }
          let nesting = 0;
          while (current[cursor] === '>') {
            ctx.budget.tick();
            nesting++;
            cursor++;
            if (current[cursor] === ' ') cursor++;
          }
          if (nesting > ctx.budget.limits.blockDepth) noteDepth();
          quote.push(current.slice(cursor));
          i++;
        }
        const value = stripInline(quote.join('\n'), runs, ctx.budget);
        if (!emitParagraph(ctx, value.text, value.runs, value.truncated)) return;
        continue;
      }
      if (i + 1 < lines.length && line.includes('|') && isSeparator(lines[i + 1]!, ctx.budget)) {
        const tableState: TableState = { textChars: 0, stopped: false };
        const first = splitTableRow(line, ctx, tableState);
        const rows: Cell[][] = [first.cells];
        i += 2;
        while (
          !tableState.stopped &&
          i < lines.length &&
          lines[i]!.includes('|') &&
          lines[i]!.trim() !== ''
        ) {
          ctx.budget.tick();
          const row = splitTableRow(lines[i]!, ctx, tableState);
          rows.push(row.cells);
          i++;
        }
        let width = 0;
        for (const row of rows) {
          ctx.budget.tick();
          if (row.length > width) width = row.length;
        }
        for (const row of rows) {
          while (row.length < width) {
            ctx.budget.tick();
            if (!ctx.budget.addCells(1)) {
              tableState.stopped = true;
              break;
            }
            row.push({ text: '' });
          }
          if (tableState.stopped) break;
        }
        if (!ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {})) return;
        if (tableState.stopped) return;
        continue;
      }
      const para: string[] = [];
      const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
      let stagedRaw = 0;
      let paragraphTruncated = false;
      const appendParagraphLine = (sourceLine: string): void => {
        const separator = para.length > 0 ? 1 : 0;
        const available = Math.max(0, remaining - stagedRaw - separator);
        if (sourceLine.length > available) {
          if (separator > 0 && available > 0) {
            para.push(sourceLine.slice(0, available));
            stagedRaw += separator + available;
          } else if (separator === 0 && available > 0) {
            para.push(sourceLine.slice(0, available));
            stagedRaw += available;
          }
          ctx.budget.checkOutputChars(remaining + 1);
          paragraphTruncated = true;
          return;
        }
        para.push(sourceLine);
        stagedRaw += separator + sourceLine.length;
      };
      appendParagraphLine(line.trim());
      i++;
      while (
        !paragraphTruncated &&
        i < lines.length &&
        lines[i]!.trim() !== '' &&
        !marker(lines[i]!, ctx.budget) &&
        !/^ {0,3}(?:>|#{1,6}[ \t]|`{3,}|~{3,})/.test(lines[i]!)
      ) {
        ctx.budget.tick();
        if (/^ {4}/.test(lines[i]!)) break;
        if (i + 1 < lines.length && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]!)) break;
        appendParagraphLine(lines[i]!.trim());
        i++;
      }
      const value = stripInline(para.join('\n'), runs, ctx.budget, remaining);
      if (!emitParagraph(ctx, value.text, value.runs, paragraphTruncated || value.truncated)) return;
    }
  },
};

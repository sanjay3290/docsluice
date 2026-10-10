import type { ReadContext } from '../core/reader.js';
import type { Cell, ListItem, Run } from '../core/model.js';
import { NAMED_ENTITIES } from './entities.js';

export interface HtmlNode {
  tag: string;
  attrs: Map<string, string>;
  children: Array<HtmlNode | string>;
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const HIDDEN = new Set(['head', 'script', 'style', 'noscript', 'template']);
const RESOURCES = new Set(['img', 'link', 'iframe', 'source']);
const MAX_ATTRIBUTES = 256;
const MAX_NODES = 100_000;
const INLINE = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'i',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'wbr',
]);
const BREAKS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'nav',
  'main',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'ul',
  'ol',
  'table',
  'pre',
]);
const space = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const letter = (c: number): boolean => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);

/** Decode bounded numeric references and 253 common named references; unknown names stay literal. */
export function decodeEntities(text: string, ctx: ReadContext, maxChars = Number.MAX_SAFE_INTEGER): string {
  let result = '';
  for (let i = 0; i < text.length && result.length < maxChars; i++) {
    ctx.budget.tick();
    if (text[i] !== '&') {
      result += text[i];
      continue;
    }
    let end = i + 1;
    while (
      end < text.length &&
      end - i <= 40 &&
      text[end] !== ';' &&
      !space(text.charCodeAt(end)) &&
      text[end] !== '&' &&
      text[end] !== '<'
    ) {
      ctx.budget.tick();
      end++;
    }
    if (text[end] !== ';') {
      result += '&';
      continue;
    }
    const name = text.slice(i + 1, end);
    let value = NAMED_ENTITIES.get(name);
    if (name[0] === '#') {
      const hex = name[1] === 'x' || name[1] === 'X';
      let code = 0;
      let valid = name.length > (hex ? 2 : 1);
      for (let j = hex ? 2 : 1; j < name.length; j++) {
        ctx.budget.tick();
        const c = name.charCodeAt(j);
        const digit =
          c >= 48 && c <= 57
            ? c - 48
            : hex && c >= 65 && c <= 70
              ? c - 55
              : hex && c >= 97 && c <= 102
                ? c - 87
                : -1;
        if (digit < 0 || digit >= (hex ? 16 : 10)) {
          valid = false;
          break;
        }
        code = code * (hex ? 16 : 10) + digit;
        if (code > 0x10ffff) {
          valid = false;
          break;
        }
      }
      if (valid)
        value = code === 0 || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code);
    }
    if (value !== undefined) {
      result += value;
      i = end;
    } else result += '&';
  }
  return result;
}

export interface HtmlTag {
  tag: string;
  attrs: Map<string, string>;
  close: boolean;
  self: boolean;
  end: number;
}

/** Scan a single lenient tag without a regular expression or file-data object keys. */
export function scanTag(text: string, start: number, ctx: ReadContext): HtmlTag | undefined {
  let pos = start + 1;
  const close = text[pos] === '/';
  if (close) pos++;
  if (!letter(text.charCodeAt(pos))) return undefined;
  const begin = pos;
  while (pos < text.length && !space(text.charCodeAt(pos)) && text[pos] !== '>' && text[pos] !== '/') {
    ctx.budget.tick();
    pos++;
  }
  const tag = text.slice(begin, Math.min(pos, begin + 64)).toLowerCase();
  const attrs = new Map<string, string>();
  const self = false;
  while (pos < text.length) {
    ctx.budget.tick();
    while (pos < text.length && space(text.charCodeAt(pos))) {
      ctx.budget.tick();
      pos++;
    }
    if (text[pos] === '>') return { tag, attrs, close, self, end: pos + 1 };
    if (text[pos] === '/' && text[pos + 1] === '>') return { tag, attrs, close, self: true, end: pos + 2 };
    const keyStart = pos;
    while (
      pos < text.length &&
      !space(text.charCodeAt(pos)) &&
      text[pos] !== '=' &&
      text[pos] !== '>' &&
      text[pos] !== '/'
    ) {
      ctx.budget.tick();
      pos++;
    }
    if (pos === keyStart) {
      pos++;
      continue;
    }
    const key = text.slice(keyStart, Math.min(pos, keyStart + 128)).toLowerCase();
    while (pos < text.length && space(text.charCodeAt(pos))) {
      ctx.budget.tick();
      pos++;
    }
    let value = '';
    if (text[pos] === '=') {
      pos++;
      while (pos < text.length && space(text.charCodeAt(pos))) {
        ctx.budget.tick();
        pos++;
      }
      const quote = text[pos] === '"' || text[pos] === "'" ? text[pos++] : undefined;
      const valueStart = pos;
      while (
        pos < text.length &&
        (quote ? text[pos] !== quote : !space(text.charCodeAt(pos)) && text[pos] !== '>')
      ) {
        ctx.budget.tick();
        pos++;
      }
      const length = pos - valueStart;
      if (length > ctx.budget.limits.outputChars) ctx.budget.checkOutputChars(length);
      value = text.slice(valueStart, valueStart + Math.min(length, ctx.budget.limits.outputChars));
      if (quote && text[pos] === quote) pos++;
    }
    if (!attrs.has(key) && attrs.size < MAX_ATTRIBUTES) attrs.set(key, value);
  }
  return { tag, attrs, close, self, end: pos };
}

function skipUntil(text: string, pos: number, marker: string, ctx: ReadContext, insensitive = false): number {
  while (pos < text.length) {
    ctx.budget.tick();
    const candidate = text.slice(pos, pos + marker.length);
    if ((insensitive ? candidate.toLowerCase() : candidate) === marker) return pos;
    pos++;
  }
  return text.length;
}

/** Iterative bounded HTML tree. Hidden content is never stored. */
export function parseHtml(text: string, ctx: ReadContext): HtmlNode {
  const root: HtmlNode = { tag: '', attrs: new Map(), children: [] };
  const stack: Array<{ node: HtmlNode; hidden: boolean }> = [{ node: root, hidden: false }];
  let pos = 0;
  let staged = 0;
  let nodes = 0;
  const positions = new Map<string, number[]>();
  const hiddenScopes: number[] = [];
  // Open tags past `blockDepth` are transparent: their content joins the nearest kept ancestor.
  const flattened = new Map<string, number>();
  let depthWarned = false;
  const topIndex = (tag: string): number => positions.get(tag)?.at(-1) ?? 0;
  const pop = (): void => {
    if (hiddenScopes.at(-1) === stack.length - 1) hiddenScopes.pop();
    const frame = stack.pop()!;
    const indices = positions.get(frame.node.tag)!;
    indices.pop();
    if (!indices.length) positions.delete(frame.node.tag);
  };
  try {
    while (pos < text.length) {
      ctx.budget.tick();
      if (text.startsWith('<!--', pos)) {
        const end = skipUntil(text, pos + 4, '-->', ctx);
        pos = Math.min(text.length, end + 3);
        continue;
      }
      if (text.startsWith('<!', pos) || text.startsWith('<?', pos)) {
        const end = skipUntil(text, pos + 2, '>', ctx);
        pos = Math.min(text.length, end + 1);
        continue;
      }
      const token = text[pos] === '<' ? scanTag(text, pos, ctx) : undefined;
      if (!token) {
        const start = pos++;
        while (pos < text.length && text[pos] !== '<') {
          ctx.budget.tick();
          pos++;
        }
        if (!stack.at(-1)!.hidden) {
          const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars - staged);
          const raw = text.slice(start, pos);
          const decoded = decodeEntities(raw, ctx, remaining + 1);
          if (!ctx.budget.checkOutputChars(staged + decoded.length)) {
            if (remaining) stack.at(-1)!.node.children.push(decoded.slice(0, remaining));
            break;
          }
          staged += decoded.length;
          stack.at(-1)!.node.children.push(decoded);
        }
        continue;
      }
      pos = token.end;
      if (token.close) {
        const open = flattened.get(token.tag) ?? 0;
        if (open > 0) {
          flattened.set(token.tag, open - 1);
          continue;
        }
        const index = topIndex(token.tag);
        if (index && index >= (hiddenScopes.at(-1) ?? 0))
          while (stack.length > index) {
            ctx.budget.tick();
            pop();
          }
        continue;
      }
      if (token.tag === 'script') ctx.out.setFeature('hasJavaScript');
      for (const key of token.attrs.keys()) {
        ctx.budget.tick();
        if (key.startsWith('on')) ctx.out.setFeature('hasJavaScript');
      }
      if (RESOURCES.has(token.tag)) {
        const target =
          token.attrs
            .get(token.tag === 'link' ? 'href' : 'src')
            ?.trim()
            .toLowerCase() ?? '';
        if (target.startsWith('http:') || target.startsWith('https:') || target.startsWith('//'))
          ctx.out.setFeature('hasExternalLinks');
      }
      let implied = BREAKS.has(token.tag) ? topIndex('p') : 0;
      if (token.tag === 'li') {
        const item = topIndex('li');
        if (item > Math.max(topIndex('ul'), topIndex('ol'))) implied = item;
      } else if (token.tag === 'td' || token.tag === 'th') {
        const cell = Math.max(topIndex('td'), topIndex('th'));
        if (cell > topIndex('tr')) implied = cell;
      } else if (token.tag === 'tr') {
        const row = topIndex('tr');
        if (row > topIndex('table')) implied = row;
      } else if (token.tag === 'option') {
        const option = topIndex('option');
        if (option > topIndex('select')) implied = option;
      }
      if (implied > (hiddenScopes.at(-1) ?? 0))
        while (stack.length > implied) {
          ctx.budget.tick();
          pop();
        }
      const node: HtmlNode = { tag: token.tag, attrs: token.attrs, children: [] };
      const hidden = stack.at(-1)!.hidden || HIDDEN.has(token.tag);
      const container =
        !VOID.has(token.tag) && !token.self && token.tag !== 'script' && token.tag !== 'style';
      if (container && !hidden && stack.length > ctx.budget.limits.blockDepth) {
        if (!depthWarned) {
          depthWarned = true;
          ctx.warnings.add({
            code: 'DEPTH_LIMIT',
            message: `HTML nesting was flattened at the configured block depth of ${ctx.budget.limits.blockDepth}.`,
          });
        }
        flattened.set(token.tag, (flattened.get(token.tag) ?? 0) + 1);
        continue;
      }
      if (!hidden) {
        if (++nodes > MAX_NODES) {
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message: 'HTML node staging exceeded 100,000 nodes; remaining content was skipped.',
          });
          break;
        }
        stack.at(-1)!.node.children.push(node);
      }
      if (token.tag === 'script' || token.tag === 'style') {
        while (pos < text.length) {
          ctx.budget.tick();
          const end = skipUntil(text, pos, '</' + token.tag, ctx, true);
          const closing = end < text.length ? scanTag(text, end, ctx) : undefined;
          if (closing?.close && closing.tag === token.tag) {
            pos = closing.end;
            break;
          }
          pos = end < text.length ? end + 2 : text.length;
        }
        continue;
      }
      if (container) {
        const indices = positions.get(node.tag) ?? [];
        indices.push(stack.length);
        positions.set(node.tag, indices);
        if (HIDDEN.has(node.tag)) hiddenScopes.push(stack.length);
        stack.push({ node, hidden });
      }
    }
    return root;
  } finally {
    while (stack.length > 1) pop();
  }
}

// HTML caps colspan at 1,000 and rowspan at 65,534 (WHATWG tables processing model).
const MAX_COLSPAN = 1000;
const MAX_ROWSPAN = 65_534;

function spanValue(raw: string | undefined, maximum: number): number {
  const span = raw === undefined ? 1 : Number(raw.trim());
  return Number.isSafeInteger(span) && span > 1 ? Math.min(span, maximum) : 1;
}

function plain(node: HtmlNode, ctx: ReadContext, preserve = false): string {
  let result = '';
  const pending: Array<HtmlNode | string> = [node];
  while (pending.length) {
    ctx.budget.tick();
    const next = pending.pop()!;
    if (typeof next === 'string') result += next;
    else if (next.tag === 'br') result += '\n';
    else if (next.tag === 'img') result += decodeEntities(next.attrs.get('alt') ?? '', ctx);
    else
      for (let i = next.children.length - 1; i >= 0; i--) {
        ctx.budget.tick();
        pending.push(next.children[i]!);
      }
  }
  if (preserve) return result;
  let normalized = '';
  let gap = false;
  for (let i = 0; i < result.length; i++) {
    ctx.budget.tick();
    if (space(result.charCodeAt(i))) gap = true;
    else {
      if (gap && normalized) normalized += ' ';
      normalized += result[i];
      gap = false;
    }
  }
  return normalized;
}

const BOLD = new Set(['b', 'strong']);
const ITALIC = new Set(['i', 'em', 'cite', 'dfn', 'var']);
const CODE = new Set(['code', 'kbd', 'samp', 'tt']);

/**
 * Inline runs (MOD-3): bold, italic, code and link targets. The text is walked exactly as `plain()`
 * walks it (line breaks, image alt text) and white space is collapsed the same way across runs, so
 * the runs join to the paragraph text. Equal neighbours are merged.
 */
function inlineRuns(node: HtmlNode, ctx: ReadContext): Run[] {
  const runs: Run[] = [];
  const pending: Array<{ value: HtmlNode | string; format: Omit<Run, 'text'> }> = [
    { value: node, format: {} },
  ];
  let gap = false;
  let started = false;
  const append = (text: string, format: Omit<Run, 'text'>): void => {
    let output = '';
    for (let i = 0; i < text.length; i++) {
      ctx.budget.tick();
      if (space(text.charCodeAt(i))) {
        // One space where the white space starts, so it stays with the run it was written in.
        if (!gap && started) output += ' ';
        gap = true;
      } else {
        output += text[i];
        gap = false;
        started = true;
      }
    }
    if (output.length === 0) return;
    const last = runs.at(-1);
    const { bold, italic, code, href } = format;
    if (last && last.bold === bold && last.italic === italic && last.code === code && last.href === href)
      last.text += output;
    else runs.push({ text: output, ...format });
  };
  while (pending.length) {
    ctx.budget.tick();
    const frame = pending.pop()!;
    if (typeof frame.value === 'string') {
      append(frame.value, frame.format);
      continue;
    }
    const tag = frame.value.tag;
    if (tag === 'br') append('\n', frame.format);
    else if (tag === 'img') append(decodeEntities(frame.value.attrs.get('alt') ?? '', ctx), frame.format);
    else {
      const format = { ...frame.format };
      if (BOLD.has(tag)) format.bold = true;
      if (ITALIC.has(tag)) format.italic = true;
      if (CODE.has(tag)) format.code = true;
      if (tag === 'a') {
        const href = frame.value.attrs.get('href');
        if (href !== undefined) format.href = href;
      }
      for (let i = frame.value.children.length - 1; i >= 0; i--) {
        ctx.budget.tick();
        pending.push({ value: frame.value.children[i]!, format });
      }
    }
  }
  // `plain()` drops white space at the end.
  const last = runs.at(-1);
  if (last && gap && last.text.endsWith(' ')) {
    last.text = last.text.slice(0, -1);
    if (last.text.length === 0) runs.pop();
  }
  return runs;
}

function imageBlock(ctx: ReadContext, node: HtmlNode, cidReferences?: ReadonlyMap<string, string>): boolean {
  const alt = node.attrs.get('alt');
  const src = decodeEntities(node.attrs.get('src') ?? '', ctx).trim();
  const cid = src.toLowerCase().startsWith('cid:') ? src.slice(4) : undefined;
  const ref = cid === undefined ? undefined : (cidReferences?.get(cid) ?? cid);
  return ctx.out.image(
    {
      ...(alt !== undefined ? { alt: decodeEntities(alt, ctx) } : {}),
      ...(ref !== undefined ? { ref } : {}),
    },
    ctx.path ? { path: ctx.path } : {},
  );
}

function inlineImages(
  ctx: ReadContext,
  node: HtmlNode,
  cidReferences?: ReadonlyMap<string, string>,
): boolean {
  const pending = [node];
  while (pending.length) {
    ctx.budget.tick();
    const part = pending.pop()!;
    if (part.tag === 'img') {
      if (!imageBlock(ctx, part, cidReferences)) return false;
    } else
      for (let i = part.children.length - 1; i >= 0; i--) {
        ctx.budget.tick();
        const child = part.children[i]!;
        if (typeof child !== 'string') pending.push(child);
      }
  }
  return true;
}

/** Selects the part of a page to emit, and elements inside it to leave out (`mainContent`, HTM-2). */
export type HtmlSelector = (
  root: HtmlNode,
  ctx: ReadContext,
) => { node: HtmlNode; skip: ReadonlySet<HtmlNode> };

/** Build blocks from bounded HTML, reusable by EML/EPUB without changing encoding metadata. */
export function emitHtml(
  ctx: ReadContext,
  html: string,
  cidReferences?: ReadonlyMap<string, string>,
  select?: HtmlSelector,
): void {
  const root = parseHtml(html, ctx);
  const loc = ctx.path ? { path: ctx.path } : {};
  const selected = select?.(root, ctx);
  const pending: Array<HtmlNode | string> = [selected?.node ?? root];
  while (pending.length) {
    ctx.budget.tick();
    const node = pending.pop()!;
    if (typeof node !== 'string' && selected?.skip.has(node)) continue;
    if (typeof node === 'string') {
      const text = node.trim();
      if (text && !ctx.out.paragraph(text, loc)) return;
      continue;
    }
    if (node.tag.length === 2 && node.tag[0] === 'h' && node.tag[1]! >= '1' && node.tag[1]! <= '6') {
      if (!ctx.out.heading(Number(node.tag[1]) as 1 | 2 | 3 | 4 | 5 | 6, plain(node, ctx), loc)) return;
    } else if (node.tag === 'p' || node.tag === 'blockquote') {
      const text = plain(node, ctx);
      if (text && !ctx.out.paragraph(text, loc, ctx.options.runs ? inlineRuns(node, ctx) : undefined)) return;
      if (!inlineImages(ctx, node, cidReferences)) return;
    } else if (node.tag === 'pre') {
      if (!ctx.out.code(plain(node, ctx, true), loc)) return;
    } else if (node.tag === 'img') {
      if (!imageBlock(ctx, node, cidReferences)) return;
    } else if (node.tag === 'ul' || node.tag === 'ol') {
      const items: ListItem[] = [];
      const work: Array<{ node: HtmlNode; items: ListItem[] }> = [{ node, items }];
      while (work.length) {
        ctx.budget.tick();
        const frame = work.pop()!;
        for (const child of frame.node.children) {
          ctx.budget.tick();
          if (typeof child === 'string' || child.tag !== 'li') continue;
          const inline: HtmlNode = { tag: '', attrs: new Map(), children: [] };
          const nested: HtmlNode[] = [];
          for (const part of child.children) {
            ctx.budget.tick();
            if (typeof part !== 'string' && (part.tag === 'ul' || part.tag === 'ol')) nested.push(part);
            else inline.children.push(part);
          }
          const item: ListItem = { text: plain(inline, ctx) };
          frame.items.push(item);
          if (nested.length) {
            item.items = [];
            for (let i = nested.length - 1; i >= 0; i--) {
              ctx.budget.tick();
              work.push({ node: nested[i]!, items: item.items });
            }
          }
        }
      }
      if (!ctx.out.list(node.tag === 'ol', items, loc)) return;
    } else if (node.tag === 'table') {
      const rows: Cell[][] = [];
      const coveredUntil: number[] = [];
      let cellsStopped = false;
      let headerRows = 0;
      let caption: string | undefined;
      const work = [node];
      while (work.length) {
        ctx.budget.tick();
        const part = work.pop()!;
        if (part !== node && part.tag === 'table') continue;
        if (part.tag === 'caption') {
          caption = plain(part, ctx);
          continue;
        }
        if (part.tag === 'tr') {
          // Rows follow the model's grid: positions covered by an earlier span hold empty cells.
          const row: Cell[] = [];
          const rowIndex = rows.length;
          let column = 0;
          let header = true;
          const placeholder = (): boolean => {
            if (!ctx.budget.addCells(1)) {
              cellsStopped = true;
              return false;
            }
            row.push({ text: '' });
            column++;
            return true;
          };
          const skipCovered = (): boolean => {
            while ((coveredUntil[column] ?? -1) >= rowIndex) {
              ctx.budget.tick();
              if (!placeholder()) return false;
            }
            return true;
          };
          for (const child of part.children) {
            ctx.budget.tick();
            if (typeof child === 'string' || (child.tag !== 'td' && child.tag !== 'th')) continue;
            if (!skipCovered()) break;
            if (!ctx.budget.addCells(1)) {
              cellsStopped = true;
              break;
            }
            const cell: Cell = { text: plain(child, ctx) };
            const colSpan = spanValue(child.attrs.get('colspan'), MAX_COLSPAN);
            const rowSpan = spanValue(child.attrs.get('rowspan'), MAX_ROWSPAN);
            if (colSpan > 1) cell.colSpan = colSpan;
            if (rowSpan > 1) cell.rowSpan = rowSpan;
            if (child.tag !== 'th') header = false;
            row.push(cell);
            if (rowSpan > 1) {
              for (let covered = column; covered < column + colSpan; covered++) {
                ctx.budget.tick();
                coveredUntil[covered] = Math.max(coveredUntil[covered] ?? -1, rowIndex + rowSpan - 1);
              }
            }
            column++;
            for (let covered = 1; covered < colSpan && !cellsStopped; covered++) placeholder();
            if (cellsStopped) break;
          }
          if (!cellsStopped) skipCovered();
          if (row.length) {
            if (header && headerRows === rows.length) headerRows++;
            rows.push(row);
          }
          if (cellsStopped) break;
        } else
          for (let i = part.children.length - 1; i >= 0; i--) {
            ctx.budget.tick();
            const child = part.children[i]!;
            if (typeof child !== 'string') work.push(child);
          }
      }
      if (!ctx.out.table(rows, headerRows, loc, caption)) return;
    } else {
      const children: HtmlNode[] = [];
      let inline: Array<HtmlNode | string> = [];
      const flush = (): void => {
        if (inline.length) {
          children.push({ tag: 'p', attrs: new Map(), children: inline });
          inline = [];
        }
      };
      for (const child of node.children) {
        ctx.budget.tick();
        if (typeof child === 'string' || INLINE.has(child.tag)) inline.push(child);
        else {
          flush();
          children.push(child);
        }
      }
      flush();
      for (let i = children.length - 1; i >= 0; i--) {
        ctx.budget.tick();
        pending.push(children[i]!);
      }
    }
  }
}

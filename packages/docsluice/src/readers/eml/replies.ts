import type { Budget } from '../../core/budget.js';
import type { ReadContext } from '../../core/reader.js';
import type { HtmlNode } from '../../html/index.js';

/** How far below a reply header line its other header lines may sit. */
const HEADER_LOOKAHEAD = 5;
/** Attribution lines longer than this are body text, not "On …, X wrote:". */
const MAX_ATTRIBUTION = 1_000;
/** Text gathered from an HTML element to recognise an attribution or an Outlook header. */
const MAX_PROBE = 2_000;
/** Nodes visited per probe, so probing nested containers stays linear in practice. */
const MAX_PROBE_NODES = 256;

/** ASCII whitespace trim, so the result never depends on Unicode tables. */
function trimLine(line: string, budget: Budget): string {
  let start = 0;
  let end = line.length;
  while (start < end && line.charCodeAt(start) <= 0x20) {
    budget.tick();
    start++;
  }
  while (end > start && line.charCodeAt(end - 1) <= 0x20) {
    budget.tick();
    end--;
  }
  return line.slice(start, end);
}

function startsWithInsensitive(text: string, prefix: string): boolean {
  return text.length >= prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix;
}

/** "On Mon, Oct 5, 2026 at 8:15 AM Alex <alex@example.test> wrote:" (Gmail, Apple Mail, Thunderbird). */
function isAttribution(text: string): boolean {
  return text.length <= MAX_ATTRIBUTION && text.startsWith('On ') && text.endsWith('wrote:');
}

/** "-----Original Message-----" (Outlook and many older clients), in any case. */
function isOriginalMessage(line: string): boolean {
  if (!line.startsWith('--') || !line.endsWith('--')) return false;
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === '-' || line[start] === ' ')) start++;
  while (end > start && (line[end - 1] === '-' || line[end - 1] === ' ')) end--;
  return line.slice(start, end).toLowerCase() === 'original message';
}

function isRule(line: string): boolean {
  if (line.length < 10) return false;
  for (let index = 0; index < line.length; index++) if (line[index] !== '_') return false;
  return true;
}

/**
 * An Outlook reply header: "From:" followed within a few lines by "Sent:", or by both "Date:" and
 * "Subject:" (Outlook on the web and Outlook for Mac).
 */
function isOutlookHeader(lines: readonly string[], index: number, budget: Budget): boolean {
  if (!startsWithInsensitive(lines[index]!, 'from:')) return false;
  let date = false;
  let subject = false;
  for (let next = index + 1; next < lines.length && next <= index + HEADER_LOOKAHEAD; next++) {
    budget.tick();
    const line = lines[next]!;
    if (startsWithInsensitive(line, 'sent:')) return true;
    if (startsWithInsensitive(line, 'date:')) date = true;
    if (startsWithInsensitive(line, 'subject:')) subject = true;
    if (date && subject) return true;
  }
  return false;
}

/** Where quoted history starts at line `index`, or false. Looks at most a few lines ahead. */
function startsHistory(lines: readonly string[], index: number, budget: Budget): boolean {
  const line = lines[index]!;
  if (isOriginalMessage(line) || isOutlookHeader(lines, index, budget)) return true;
  if (isRule(line)) {
    for (let next = index + 1; next < lines.length && next <= index + 2; next++) {
      budget.tick();
      if (lines[next]!.length === 0) continue;
      return startsWithInsensitive(lines[next]!, 'from:');
    }
    return false;
  }
  if (!line.startsWith('On ')) return false;
  // Clients wrap a long attribution over up to three lines.
  let joined = line;
  for (let next = index; next < lines.length && next <= index + 2; next++) {
    budget.tick();
    if (next > index) joined += ` ${lines[next]!}`;
    if (isAttribution(joined)) return true;
    if (joined.length > MAX_ATTRIBUTION) return false;
  }
  return false;
}

/**
 * Plain-text body without quoted reply history (EML-4): everything from the first reply header
 * (an "On …, X wrote:" attribution, "-----Original Message-----", or an Outlook "From:/Sent:" block)
 * to the end, and every line that starts with `>`. One pass over the lines, with a fixed look-ahead;
 * no regular expressions.
 */
export function dropQuotedText(text: string, budget: Budget): string {
  const raw: string[] = [];
  const lines: string[] = [];
  let start = 0;
  while (start <= text.length) {
    budget.tick();
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    const line = text.slice(start, end);
    raw.push(line);
    lines.push(trimLine(line, budget));
    start = end + 1;
  }
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    budget.tick();
    if (startsHistory(lines, index, budget)) break;
    // Kept lines keep their own indentation; only the tests use the trimmed form.
    if (!lines[index]!.startsWith('>')) kept.push(raw[index]!);
  }
  return kept.join('\n');
}

function hasClass(node: HtmlNode, name: string, budget: Budget): boolean {
  const value = node.attrs.get('class');
  if (value === undefined) return false;
  for (const part of value.split(' ')) {
    budget.tick();
    if (part.toLowerCase() === name) return true;
  }
  return false;
}

/** Up to `MAX_PROBE` characters of an element's text, whitespace collapsed. */
function probeText(node: HtmlNode, budget: Budget): string {
  let text = '';
  let visited = 0;
  const stack: Array<HtmlNode | string> = [node];
  while (stack.length > 0 && text.length < MAX_PROBE && visited++ < MAX_PROBE_NODES) {
    budget.tick();
    const current = stack.pop()!;
    if (typeof current === 'string') {
      text += ` ${current}`;
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index--) stack.push(current.children[index]!);
  }
  let collapsed = '';
  let space = false;
  for (let index = 0; index < text.length && collapsed.length < MAX_PROBE; index++) {
    budget.tick();
    const code = text.charCodeAt(index);
    if (code <= 0x20 || code === 0xa0) {
      space = collapsed.length > 0;
      continue;
    }
    if (space) collapsed += ' ';
    space = false;
    collapsed += text[index];
  }
  return collapsed;
}

/** A quoted block: Gmail, Yahoo and Thunderbird classes, or a `blockquote type="cite"` (Apple Mail). */
function isQuote(node: HtmlNode, budget: Budget): boolean {
  if (hasClass(node, 'gmail_quote', budget) || hasClass(node, 'yahoo_quoted', budget)) return true;
  return node.tag === 'blockquote' && node.attrs.get('type')?.toLowerCase() === 'cite';
}

/** An attribution element before a quote: Gmail and Thunderbird classes, or "On …, X wrote:" text. */
function isAttributionNode(node: HtmlNode, budget: Budget): boolean {
  if (hasClass(node, 'gmail_attr', budget) || hasClass(node, 'moz-cite-prefix', budget)) return true;
  return isAttribution(probeText(node, budget));
}

/**
 * Where an Outlook reply starts: the `divRplyFwdMsg` or `appendonsend` markers of Outlook on the
 * web, or a desktop header block whose text starts with "From:" and has "Sent:". The quoted message
 * follows the marker as its siblings.
 */
function isOutlookStart(node: HtmlNode, budget: Budget): boolean {
  const id = node.attrs.get('id');
  if (id === 'divRplyFwdMsg' || id === 'appendonsend') return true;
  if (node.tag !== 'div') return false;
  const text = probeText(node, budget);
  return startsWithInsensitive(text, 'from:') && text.includes('Sent:') && text.length < MAX_PROBE;
}

/**
 * An `emitHtml` selector that drops quoted reply history from an HTML body (EML-4): quote blocks and
 * the attribution line before them, and an Outlook reply marker with everything after it in the same
 * parent. The tree is walked with an explicit stack (SEC-8). It belongs to this one read, so cut
 * siblings are removed in place.
 */
export function quotedHtml(root: HtmlNode, ctx: ReadContext): { node: HtmlNode; skip: Set<HtmlNode> } {
  const skip = new Set<HtmlNode>();
  const stack: HtmlNode[] = [root];
  while (stack.length > 0) {
    ctx.budget.tick();
    const node = stack.pop()!;
    let previous: HtmlNode | undefined;
    for (let index = 0; index < node.children.length; index++) {
      ctx.budget.tick();
      const child = node.children[index]!;
      if (typeof child === 'string') {
        if (trimLine(child, ctx.budget).length > 0) previous = undefined;
        continue;
      }
      if (isOutlookStart(child, ctx.budget)) {
        node.children.length = index;
        break;
      }
      if (isQuote(child, ctx.budget)) {
        skip.add(child);
        if (previous && isAttributionNode(previous, ctx.budget)) skip.add(previous);
        previous = undefined;
        continue;
      }
      if (hasClass(child, 'gmail_attr', ctx.budget) || hasClass(child, 'moz-cite-prefix', ctx.budget)) {
        skip.add(child);
        continue;
      }
      previous = child;
      stack.push(child);
    }
  }
  return { node: root, skip };
}

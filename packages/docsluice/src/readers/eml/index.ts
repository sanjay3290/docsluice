import type { Cell } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeMimeText, parseContentType, parseMime, type MimePart } from '../../mime/index.js';
import { emitHtml } from '../html/index.js';
import { dropQuotedReplies } from './replies.js';

function cleanHeader(value: string | undefined): string | undefined {
  return value?.replace(/[\r\n\t ]+/g, ' ').trim() || undefined;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : cleanHeader(value);
}

function safeAttachmentName(
  source: string | undefined,
  contentId: string | undefined,
  budget: ReadContext['budget'],
): string {
  const name = source ?? (contentId ? `inline-${contentId}` : 'attachment');
  let safe = '';
  for (let index = 0; index < name.length; index++) {
    budget.tick();
    const code = name.charCodeAt(index);
    const char = name[index]!;
    safe += code < 0x20 || code === 0x7f || char === '/' || char === '\\' ? '_' : char;
  }
  let start = 0;
  let end = safe.length;
  while (start < end && (safe[start] === ' ' || safe[start] === '\t' || safe[start] === '.')) {
    budget.tick();
    start++;
  }
  while (end > start && (safe[end - 1] === ' ' || safe[end - 1] === '\t' || safe[end - 1] === '.')) {
    budget.tick();
    end--;
  }
  return start < end ? safe.slice(start, end) : 'attachment';
}

function topLevelParts(parts: MimePart[], budget: ReadContext['budget']): MimePart[] {
  const selected: MimePart[] = [];
  const stack = [...parts].reverse();
  while (stack.length > 0) {
    budget.tick();
    const part = stack.pop()!;
    if (part.contentType.value === 'multipart/alternative') {
      const leaves: MimePart[] = [];
      const nested = [...part.parts].reverse();
      while (nested.length > 0) {
        budget.tick();
        const child = nested.pop()!;
        if (child.disposition.value === 'attachment' || child.filename) continue;
        if (child.parts.length > 0)
          for (let index = child.parts.length - 1; index >= 0; index--) nested.push(child.parts[index]!);
        else leaves.push(child);
      }
      const plain = leaves.find((leaf) => leaf.contentType.value === 'text/plain');
      const html = leaves.find((leaf) => leaf.contentType.value === 'text/html');
      if (plain) selected.push(plain);
      else if (html) selected.push(html);
      continue;
    }
    if (part.disposition.value === 'attachment' || part.filename) continue;
    if (part.parts.length > 0) {
      for (let index = part.parts.length - 1; index >= 0; index--) stack.push(part.parts[index]!);
    } else if (part.contentType.value === 'text/plain' || part.contentType.value === 'text/html')
      selected.push(part);
  }
  return selected;
}

function allParts(parts: MimePart[], budget: ReadContext['budget']): MimePart[] {
  const result: MimePart[] = [];
  const stack = [...parts].reverse();
  while (stack.length > 0) {
    budget.tick();
    const part = stack.pop()!;
    result.push(part);
    for (let index = part.parts.length - 1; index >= 0; index--) stack.push(part.parts[index]!);
  }
  return result;
}

function emitPlain(ctx: ReadContext, text: string): void {
  let start = 0;
  while (start < text.length) {
    ctx.budget.tick();
    let end = start;
    while (
      end < text.length &&
      !(text.charCodeAt(end) === 10 && (end + 1 === text.length || text.charCodeAt(end + 1) === 10))
    ) {
      ctx.budget.tick();
      end++;
    }
    const paragraph = text.slice(start, end).trim();
    if (paragraph && !ctx.out.paragraph(paragraph, ctx.path ? { path: ctx.path } : {})) return;
    start = end;
    while (start < text.length && (text[start] === '\n' || text[start] === '\r')) {
      ctx.budget.tick();
      start++;
    }
  }
}

function emitParts(
  ctx: ReadContext,
  parts: MimePart[],
  cidReferences: ReadonlyMap<string, string>,
  quotedReplies: 'keep' | 'drop',
): void {
  for (const part of parts) {
    ctx.budget.tick();
    if (part.contentType.value === 'text/html') {
      // The parser charges raw HTML bytes to totalUncompressedBytes; only emitted text uses outputChars.
      const html = decodeMimeText(part, ctx.budget, part.bytes?.length ?? 0);
      emitHtml(ctx, html, false, cidReferences);
    } else {
      const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
      let text = decodeMimeText(part, ctx.budget, remaining + 1);
      if (text.length > remaining) {
        ctx.budget.checkOutputChars(remaining + 1);
        text = text.slice(0, remaining);
      }
      emitPlain(ctx, quotedReplies === 'drop' ? dropQuotedReplies(text, ctx.budget) : text);
    }
  }
}

/** Read a MIME email while keeping all attachment expansion on the parent's child pipeline. */
export async function readEml(ctx: ReadContext, quotedReplies: 'keep' | 'drop' = 'keep'): Promise<void> {
  ctx.budget.tick();
  const message = parseMime(ctx.bytes, ctx.budget);
  const from = cleanHeader(message.headers.get('from'));
  const to = cleanHeader(message.headers.get('to'));
  const cc = cleanHeader(message.headers.get('cc'));
  const subject = cleanHeader(message.headers.get('subject'));
  const date = normalizeDate(message.headers.get('date'));
  if (subject) ctx.out.setMetadata({ title: subject });
  if (date) ctx.out.setMetadata({ created: date });
  if (from && ctx.options.metadata) ctx.out.setMetadata({ authors: [from] });
  const rows: Cell[][] = [[{ text: 'Field' }, { text: 'Value' }]];
  if (ctx.options.metadata) {
    if (from) rows.push([{ text: 'From' }, { text: from }]);
    if (to) rows.push([{ text: 'To' }, { text: to }]);
    if (cc) rows.push([{ text: 'Cc' }, { text: cc }]);
  }
  if (date) rows.push([{ text: 'Date' }, { text: date }]);
  else if (message.headers.has('date'))
    rows.push([{ text: 'Date' }, { text: cleanHeader(message.headers.get('date'))! }]);
  if (subject) rows.push([{ text: 'Subject' }, { text: subject }]);
  if (rows.length > 1) ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});

  const flattened = allParts(message.parts, ctx.budget);
  let hasAttachments = false;
  const cidReferences = new Map<string, string>();
  for (const part of flattened) {
    ctx.budget.tick();
    const attached =
      part.disposition.value === 'attachment' ||
      part.filename !== undefined ||
      (part.disposition.value === 'inline' && part.contentId !== undefined) ||
      part.contentType.value === 'message/rfc822';
    if (!attached || !part.bytes) continue;
    hasAttachments = true;
    const name = safeAttachmentName(part.filename, part.contentId, ctx.budget);
    await ctx.extractChild(name, part.bytes, { mimeType: part.contentType.value });
    if (part.disposition.value === 'inline' && part.contentId) {
      cidReferences.set(part.contentId, ctx.path ? `${ctx.path}/${name}` : name);
    }
  }
  if (hasAttachments) ctx.out.setFeature('hasEmbeddedFiles');

  let bodyParts = topLevelParts(message.parts, ctx.budget);
  const alt = parseContentType(message.headers.get('content-type'));
  if (alt.value === 'multipart/alternative') bodyParts = topLevelParts(message.parts, ctx.budget);
  emitParts(ctx, bodyParts, cidReferences, quotedReplies);
}

export const reader: Reader = {
  id: 'eml',
  mimeTypes: ['message/rfc822'],
  async read(ctx: ReadContext): Promise<void> {
    await readEml(ctx);
  },
};

export { dropQuotedReplies } from './replies.js';
export default reader;

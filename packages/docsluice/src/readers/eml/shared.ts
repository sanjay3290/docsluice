import type { ReadContext } from '../../core/reader.js';

/** A safe child name from an attachment filename or Content-ID: no separators or control characters. */
export function safeAttachmentName(
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

/** Emit plain text as paragraphs split on blank lines. */
export function emitPlain(ctx: ReadContext, text: string): void {
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

import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';

/** Plain text reader. Blank lines separate paragraphs; line breaks within each paragraph are retained. */
export const txtReader: Reader = {
  id: 'txt',
  mimeTypes: ['text/plain'],
  // The common reader contract is async so readers can extract nested documents.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    let lineStart = 0;
    let paragraph = '';
    for (let index = 0; index <= text.length; index++) {
      ctx.budget.tick();
      if (index < text.length && text.charCodeAt(index) !== 0x0a && text.charCodeAt(index) !== 0x0d) continue;
      let end = index;
      if (end > lineStart && text.charCodeAt(end - 1) === 0x0d) end--;
      let blank = true;
      for (let cursor = lineStart; cursor < end; cursor++) {
        ctx.budget.tick();
        const code = text.charCodeAt(cursor);
        if (code !== 0x20 && code !== 0x09) {
          blank = false;
          break;
        }
      }
      if (blank) {
        if (paragraph.length > 0 && !emitParagraph(ctx, paragraph)) return;
        paragraph = '';
      } else {
        if (paragraph.length > 0) paragraph += '\n';
        paragraph += text.slice(lineStart, end);
      }
      if (index < text.length && text.charCodeAt(index) === 0x0d && text.charCodeAt(index + 1) === 0x0a)
        index++;
      lineStart = index + 1;
    }
    if (paragraph.length > 0) emitParagraph(ctx, paragraph);
  },
};

function emitParagraph(ctx: ReadContext, text: string): boolean {
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  if (text.length > remaining) {
    ctx.budget.checkOutputChars(text.length);
    if (remaining > 0) ctx.out.paragraph(text.slice(0, remaining), ctx.path ? { path: ctx.path } : {});
    return false;
  }
  return ctx.out.paragraph(text, ctx.path ? { path: ctx.path } : {});
}

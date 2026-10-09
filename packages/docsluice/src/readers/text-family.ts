import type { ReadContext } from '../core/reader.js';
import { decodeText, detectEncoding } from '../detect/encoding.js';

/** Decode a text-format input with the shared encoding detector. */
export function decodeReaderText(ctx: ReadContext): string | undefined {
  ctx.budget.tick();
  const detected = detectEncoding(ctx.bytes);
  if (!detected.isText || detected.encoding === 'unsupported') return undefined;
  const text = decodeText(ctx.bytes, detected.encoding);
  ctx.out.setEncoding(detected.encoding);
  if (detected.warning) {
    ctx.warnings.add({ code: detected.warning, message: 'Text encoding was inferred from the byte sample.' });
  }
  return text;
}

/** Emit source text up to the remaining output allowance and stop when truncated. */
export function emitParagraph(ctx: ReadContext, text: string, path?: string): boolean {
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  const fullPath =
    path === undefined ? ctx.path : ctx.path === '' ? path : path ? `${ctx.path}/${path}` : ctx.path;
  const loc = fullPath === '' ? {} : { path: fullPath };
  if (text.length > remaining) {
    ctx.budget.checkOutputChars(text.length);
    if (remaining > 0) ctx.out.paragraph(text.slice(0, remaining), loc);
    return false;
  }
  return ctx.out.paragraph(text, loc);
}

/** Emit a code block prefix, preserving the language label under the same output limit. */
export function emitCode(ctx: ReadContext, text: string, language?: string): boolean {
  const remaining = Math.max(0, ctx.budget.limits.outputChars - ctx.budget.outputChars);
  const loc = ctx.path ? { path: ctx.path } : {};
  if (text.length > remaining) {
    ctx.budget.checkOutputChars(text.length);
    if (remaining > 0) ctx.out.code(text.slice(0, remaining), loc, language);
    return false;
  }
  return ctx.out.code(text, loc, language);
}

export function warnDepth(ctx: ReadContext, format: string): void {
  ctx.warnings.add({
    code: 'DEPTH_LIMIT',
    message: `${format} nesting exceeded the configured block depth of ${ctx.budget.limits.blockDepth}.`,
  });
}

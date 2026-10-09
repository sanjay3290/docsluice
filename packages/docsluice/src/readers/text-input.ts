import type { ReadContext } from '../core/reader.js';
import { decodeText, detectEncoding, type TextEncoding } from '../detect/encoding.js';

/**
 * Detect a text reader's input encoding and record it on the document. Returns undefined for
 * binary input. Detection already reports a guessed encoding unless the caller forced the
 * format, so the warning is added only when it is not yet present.
 */
export function detectTextInput(ctx: ReadContext): Exclude<TextEncoding, 'unsupported'> | undefined {
  const detected = detectEncoding(ctx.bytes);
  if (!detected.isText || detected.encoding === 'unsupported') return undefined;
  ctx.out.setEncoding(detected.encoding);
  const code = detected.warning;
  if (code && !ctx.warnings.warnings.some((warning) => warning.code === code)) {
    ctx.warnings.add({ code, message: 'The text encoding was inferred from the byte sample.' });
  }
  return detected.encoding;
}

/** Decode a text reader's whole input after {@link detectTextInput}. */
export function decodeTextInput(ctx: ReadContext): string | undefined {
  const encoding = detectTextInput(ctx);
  return encoding === undefined ? undefined : decodeText(ctx.bytes, encoding);
}

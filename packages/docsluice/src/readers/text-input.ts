import type { ReadContext } from '../core/reader.js';
import { decodeText, detectEncoding } from '../detect/encoding.js';

/**
 * Decode a text reader's input and record its encoding. Returns undefined for binary input.
 * Detection already reports a guessed encoding unless the caller forced the format, so the
 * warning is added only when it is not yet present.
 */
export function decodeTextInput(ctx: ReadContext): string | undefined {
  const detected = detectEncoding(ctx.bytes);
  if (!detected.isText || detected.encoding === 'unsupported') return undefined;
  const text = decodeText(ctx.bytes, detected.encoding);
  ctx.out.setEncoding(detected.encoding);
  const code = detected.warning;
  if (code && !ctx.warnings.warnings.some((warning) => warning.code === code)) {
    ctx.warnings.add({ code, message: 'The text encoding was inferred from the byte sample.' });
  }
  return text;
}

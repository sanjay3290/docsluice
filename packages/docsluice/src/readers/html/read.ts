import type { ReadContext } from '../../core/reader.js';
import { decodeText, detectEncoding } from '../../detect/encoding.js';
import { emitHtml, scanTag } from '../../html/index.js';

function charsetParameter(value: string): string | undefined {
  // Declaration/hint parsing is bounded independently of payload size.
  for (const field of value.slice(0, 1024).split(';')) {
    const equal = field.indexOf('=');
    if (equal < 0 || field.slice(0, equal).trim().toLowerCase() !== 'charset') continue;
    const label = field.slice(equal + 1).trim();
    return label.length >= 2 && (label[0] === '"' || label[0] === "'") && label.at(-1) === label[0]
      ? label.slice(1, -1)
      : label;
  }
  return undefined;
}

function declaredCharset(bytes: Uint8Array, ctx: ReadContext): string | undefined {
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, 1024));
  for (let pos = 0; pos < head.length; pos++) {
    ctx.budget.tick();
    if (head.startsWith('<!--', pos)) {
      const end = head.indexOf('-->', pos + 4);
      if (end < 0) return undefined;
      pos = end + 2;
      continue;
    }
    if (head[pos] !== '<') continue;
    const tag = scanTag(head, pos, ctx);
    if (!tag) continue;
    pos = tag.end - 1;
    if (!tag.close && (tag.tag === 'script' || tag.tag === 'style')) {
      const end = head.toLowerCase().indexOf('</' + tag.tag, pos + 1);
      if (end < 0) return undefined;
      pos = end - 1;
      continue;
    }
    if (tag.close || tag.tag !== 'meta') continue;
    const charset = tag.attrs.get('charset');
    if (charset) return charset;
    if (tag.attrs.get('http-equiv')?.toLowerCase() === 'content-type') {
      const label = charsetParameter(tag.attrs.get('content') ?? '');
      if (label) return label;
    }
  }
  return undefined;
}

/** Decode HTML by BOM, declared charset, MIME hint, then detection, and emit its visible blocks. */
export async function readHtml(ctx: ReadContext): Promise<void> {
  await Promise.resolve();
  ctx.budget.tick();
  const detected = detectEncoding(ctx.bytes);
  const bom =
    (ctx.bytes[0] === 0xef && ctx.bytes[1] === 0xbb && ctx.bytes[2] === 0xbf) ||
    (ctx.bytes[0] === 0xff && ctx.bytes[1] === 0xfe) ||
    (ctx.bytes[0] === 0xfe && ctx.bytes[1] === 0xff);
  let encoding: string = detected.encoding === 'unsupported' ? 'utf-8' : detected.encoding;
  if (!bom)
    encoding = declaredCharset(ctx.bytes, ctx) ?? charsetParameter(ctx.options.mimeType ?? '') ?? encoding;
  let text: string;
  try {
    const decoder = new TextDecoder(encoding);
    encoding = decoder.encoding;
    text = decoder.decode(ctx.bytes);
  } catch {
    encoding = detected.encoding === 'unsupported' ? 'utf-8' : detected.encoding;
    text = decodeText(ctx.bytes, detected.encoding === 'unsupported' ? 'utf-8' : detected.encoding);
    ctx.warnings.add({
      code: 'ENCODING_GUESSED',
      message: 'Unsupported HTML charset; using the detected fallback.',
    });
  }
  ctx.out.setEncoding(encoding);
  emitHtml(ctx, text);
}

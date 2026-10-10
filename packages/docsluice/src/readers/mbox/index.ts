import type { Reader, ReadContext } from '../../core/reader.js';

const FROM = [0x46, 0x72, 0x6f, 0x6d, 0x20] as const; // "From "

/** `From ` at `offset`. */
function isFromLine(bytes: Uint8Array, offset: number): boolean {
  if (offset + FROM.length > bytes.length) return false;
  for (let index = 0; index < FROM.length; index++) if (bytes[offset + index] !== FROM[index]) return false;
  return true;
}

/** The line from `start` to `end` (its `\n` excluded) is empty, or only `\r`. */
function isBlankLine(bytes: Uint8Array, start: number, end: number): boolean {
  return end === start || (end === start + 1 && bytes[start] === 0x0d);
}

/**
 * One message body without its envelope line, with mboxrd quoting removed: a line of one or more
 * `>` followed by `From ` loses one `>` (RFC 4155, mboxrd). The trailing blank separator line goes.
 */
function unescape(ctx: ReadContext, bytes: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  let length = 0;
  let line = start;
  while (line < end) {
    ctx.budget.tick();
    let next = bytes.indexOf(0x0a, line);
    next = next < 0 || next >= end ? end : next + 1;
    let quotes = line;
    while (quotes < next && bytes[quotes] === 0x3e) quotes++;
    const from = quotes > line && isFromLine(bytes, quotes) ? line + 1 : line;
    out.set(bytes.subarray(from, next), length);
    length += next - from;
    line = next;
  }
  // Drop the blank line that separates this message from the next envelope.
  if (length >= 2 && out[length - 1] === 0x0a && out[length - 2] === 0x0a) length -= 1;
  else if (length >= 4 && out[length - 1] === 0x0a && out[length - 2] === 0x0d && out[length - 3] === 0x0a)
    length -= 2;
  return out.subarray(0, length);
}

/**
 * Reader for Unix mailboxes (`mbox`, RFC 4155): each message, from its `From ` envelope line to
 * the next envelope line that follows a blank line, becomes one child (`message-N.eml`) read by
 * the EML reader under the shared budget. mboxrd `>From ` quoting is undone; mboxo files, which
 * did not quote, read the same way.
 */
export const mboxReader: Reader = {
  id: 'mbox',
  mimeTypes: ['application/mbox'],
  async read(ctx): Promise<void> {
    const bytes = ctx.bytes;
    // Envelope line starts: offset 0, and every `From ` line after an empty line.
    const starts: number[] = [];
    let line = 0;
    let previousBlank = true;
    while (line < bytes.length) {
      ctx.budget.tick();
      let next = bytes.indexOf(0x0a, line);
      const end = next < 0 ? bytes.length : next;
      next = next < 0 ? bytes.length : next + 1;
      if (previousBlank && isFromLine(bytes, line)) starts.push(line);
      previousBlank = isBlankLine(bytes, line, end);
      line = next;
    }
    if (starts.length === 0) {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The mailbox has no From envelope line.' });
      return;
    }
    if (ctx.options.children === 'skip') return;
    for (let index = 0; index < starts.length; index++) {
      ctx.budget.tick();
      if (!ctx.budget.addEntries(1)) return;
      const envelopeEnd = bytes.indexOf(0x0a, starts[index]);
      const bodyStart = envelopeEnd < 0 ? bytes.length : envelopeEnd + 1;
      const bodyEnd = starts[index + 1] ?? bytes.length;
      const name = `message-${index + 1}.eml`;
      if (ctx.options.children === 'list') {
        ctx.out.addChild({
          path: ctx.path ? `${ctx.path}/${name}` : name,
          name,
          status: 'listed',
          sizeBytes: bodyEnd - bodyStart,
          mimeType: 'message/rfc822',
        });
        continue;
      }
      if (!ctx.budget.addUncompressed(bodyEnd - bodyStart)) return;
      await ctx.extractChild(name, unescape(ctx, bytes, bodyStart, bodyEnd), { mimeType: 'message/rfc822' });
    }
  },
};

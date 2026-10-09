import type { ReadContext, Reader } from '../../core/reader.js';

function separator(bytes: Uint8Array, start: number): boolean {
  if (start !== 0 && bytes[start - 1] !== 10) return false;
  return (
    bytes[start] === 70 &&
    bytes[start + 1] === 114 &&
    bytes[start + 2] === 111 &&
    bytes[start + 3] === 109 &&
    bytes[start + 4] === 32
  );
}

/** Split an mbox stream into RFC 5322 messages and remove one mboxrd escape marker. */
export function splitMbox(bytes: Uint8Array, budget: ReadContext['budget']): Uint8Array[] {
  const starts: number[] = [];
  let overflowAt: number | undefined;
  for (let index = 0; index + 5 <= bytes.length; index++) {
    budget.tick();
    if (separator(bytes, index)) {
      if (!budget.addEntries(1)) {
        overflowAt = index;
        break;
      }
      starts.push(index);
    }
  }
  const messages: Uint8Array[] = [];
  for (let messageIndex = 0; messageIndex < starts.length; messageIndex++) {
    budget.tick();
    let start = starts[messageIndex]!;
    const end = messageIndex + 1 < starts.length ? starts[messageIndex + 1]! : (overflowAt ?? bytes.length);
    while (start < end && bytes[start] !== 10) {
      budget.tick();
      start++;
    }
    if (start < end) start++;
    const output = new Uint8Array(end - start);
    let written = 0;
    let inHeaders = true;
    for (let index = start; index < end;) {
      budget.tick();
      let lineEnd = index;
      while (lineEnd < end && bytes[lineEnd] !== 10) {
        budget.tick();
        lineEnd++;
      }
      const blankHeaderLine =
        inHeaders && (lineEnd === index || (lineEnd === index + 1 && bytes[index] === 13));
      let unescape = !inHeaders && lineEnd - index > 5;
      if (unescape) {
        let cursor = index;
        while (cursor < lineEnd && bytes[cursor] === 62) {
          budget.tick();
          cursor++;
        }
        unescape =
          cursor > index &&
          bytes[cursor] === 70 &&
          bytes[cursor + 1] === 114 &&
          bytes[cursor + 2] === 111 &&
          bytes[cursor + 3] === 109 &&
          bytes[cursor + 4] === 32;
        if (unescape) index++;
      }
      for (; index < lineEnd; index++) {
        budget.tick();
        output[written++] = bytes[index]!;
      }
      if (blankHeaderLine) inHeaders = false;
      if (lineEnd < end) {
        output[written++] = 10;
        index = lineEnd + 1;
      }
    }
    messages.push(output.subarray(0, written));
  }
  return messages;
}

/** Read an mbox file as one extracted child document per envelope-delimited message. */
export const reader: Reader = {
  id: 'mbox',
  mimeTypes: ['application/mbox', 'application/x-mbox'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const messages = splitMbox(ctx.bytes, ctx.budget);
    let index = 0;
    for (const message of messages) {
      ctx.budget.tick();
      index++;
      await ctx.extractChild(`message-${index}.eml`, message, { mimeType: 'message/rfc822' });
    }
    if (messages.length === 0 && ctx.bytes.length > 0)
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'No mbox message separators were found.' });
  },
};

export default reader;

import type { Budget } from '../../core/budget.js';

/** Remove common quoted-history separators, scanning once and charging each line to the caller's budget. */
export function dropQuotedReplies(text: string, budget: Pick<Budget, 'tick'>): string {
  let start = 0;
  while (start <= text.length) {
    budget.tick();
    const end = text.indexOf('\n', start);
    const stop = end < 0 ? text.length : end;
    const line = text.slice(start, stop).replace(/\r$/, '');
    const trimmed = line.trim();
    const gmailOrApple = trimmed.startsWith('On ') && trimmed.endsWith('wrote:');
    let outlook = false;
    if (/^From:\s*\S/i.test(trimmed)) {
      const lines = text.slice(stop + (end < 0 ? 0 : 1)).split('\n', 5);
      let sent = false;
      let to = false;
      for (let index = 0; index < lines.length; index++) {
        budget.tick();
        const next = lines[index]!.trim();
        if (/^Sent:\s*\S/i.test(next)) sent = true;
        else if (/^To:\s*\S/i.test(next)) to = true;
        else if (index > 0 && next === '') break;
      }
      outlook = sent && to;
    }
    if (gmailOrApple || outlook || trimmed.startsWith('>')) {
      let endOfReply = start;
      while (endOfReply > 0) {
        budget.tick();
        const code = text.charCodeAt(endOfReply - 1);
        if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
        endOfReply--;
      }
      return `${text.slice(0, endOfReply)}\n`;
    }
    if (end < 0) break;
    start = end + 1;
  }
  return text;
}

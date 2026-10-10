import type { ReadContext, Reader } from '../../core/reader.js';
import { emitJsonLeaves, withinBlockDepth } from '../json/leaves.js';
import { decodeTextInput } from '../text-input.js';
import { isBlank, splitLines } from '../text-lines.js';

/** Whether a line starts and ends with characters a JSON value can start and end with (RFC 8259). */
function mayBeJson(line: string): boolean {
  let start = 0;
  let end = line.length - 1;
  while (start <= end && isJsonSpace(line.charCodeAt(start))) start++;
  while (end >= start && isJsonSpace(line.charCodeAt(end))) end--;
  if (start > end) return false;
  const first = line.charCodeAt(start);
  const last = line.charCodeAt(end);
  const firstOk =
    first === 0x7b ||
    first === 0x5b ||
    first === 0x22 ||
    first === 0x2d ||
    isDigit(first) ||
    first === 0x74 ||
    first === 0x66 ||
    first === 0x6e;
  // Values end with `}`, `]`, `"`, a digit, `e` (true, false) or `l` (null).
  const lastOk =
    last === 0x7d || last === 0x5d || last === 0x22 || isDigit(last) || last === 0x65 || last === 0x6c;
  return firstOk && lastOk;
}

function isJsonSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** NDJSON / JSON Lines reader: each non-empty line is one JSON record, read like the JSON reader. */
export const ndjsonReader: Reader = {
  id: 'ndjson',
  mimeTypes: ['application/x-ndjson'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    let record = 0;
    let malformed = 0;
    let tooDeep = 0;
    for (const line of splitLines(text, ctx.budget)) {
      ctx.budget.tick();
      if (isBlank(line)) continue;
      const index = record++;
      // Nesting is checked before JSON.parse, so hostile depth never reaches its recursive parser.
      if (!withinBlockDepth(line, ctx, false)) {
        tooDeep++;
        continue;
      }
      // A line that cannot start or end a JSON value is malformed without a throwing JSON.parse,
      // so a flood of junk lines stays cheap.
      if (!mayBeJson(line)) {
        malformed++;
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        malformed++;
        continue;
      }
      if (!emitJsonLeaves(ctx, value, `$[${index}]`)) break;
      // A streaming consumer can apply backpressure between records (EXT-2).
      if (record % 256 === 0) await ctx.out.flush();
    }
    if (tooDeep > 0)
      ctx.warnings.add({
        code: 'DEPTH_LIMIT',
        message: `${tooDeep} record(s) nest deeper than the block depth limit of ${ctx.budget.limits.blockDepth} and were skipped.`,
      });
    if (malformed > 0)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: `${malformed} line(s) are not valid JSON and were skipped.`,
      });
  },
};

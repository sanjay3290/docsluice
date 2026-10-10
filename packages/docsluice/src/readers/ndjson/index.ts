import type { ReadContext, Reader } from '../../core/reader.js';
import { emitJsonLeaves, withinBlockDepth } from '../json/leaves.js';
import { decodeTextInput } from '../text-input.js';
import { isBlank, splitLines } from '../text-lines.js';

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

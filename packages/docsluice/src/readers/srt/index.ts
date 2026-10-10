import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';
import { emitCues, parseCues } from './cues.js';

/** SubRip reader: one paragraph per cue, tags removed, with the cue time range as `loc.path`. */
export const srtReader: Reader = {
  id: 'srt',
  mimeTypes: ['application/x-subrip'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const { cues, skipped } = parseCues(text, ctx.budget);
    await emitCues(ctx, cues);
    if (skipped > 0)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: `${skipped} block(s) have no cue timing line and were skipped.`,
      });
  },
};

import type { ReadContext, Reader } from '../../core/reader.js';
import { emitCues, parseCues } from '../srt/cues.js';
import { decodeTextInput } from '../text-input.js';

/**
 * WebVTT reader: one paragraph per cue, with voice, class and timestamp tags removed and the cue
 * time range as `loc.path`. The header and NOTE, STYLE and REGION blocks are not content.
 */
export const vttReader: Reader = {
  id: 'vtt',
  mimeTypes: ['text/vtt'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const { cues } = parseCues(text, ctx.budget);
    await emitCues(ctx, cues);
  },
};

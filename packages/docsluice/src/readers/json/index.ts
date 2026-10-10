import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';
import { emitJsonLeaves, prettyJson, withinBlockDepth } from './leaves.js';

const PRETTY_JSON_MAX_BYTES = 64 * 1024;

/** JSON reader: emits scalar leaves with stable JSON-style paths and a small pretty code view. */
export const jsonReader: Reader = {
  id: 'json',
  mimeTypes: ['application/json', 'text/json'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    await Promise.resolve();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    if (!withinBlockDepth(text, ctx)) return;

    let root: unknown;
    try {
      root = JSON.parse(text) as unknown;
    } catch {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Malformed JSON could not be read.' });
      return;
    }

    if (!emitJsonLeaves(ctx, root, '$')) return;

    if (ctx.bytes.length < PRETTY_JSON_MAX_BYTES) {
      const pretty = prettyJson(root, ctx);
      if (pretty !== undefined) ctx.out.code(pretty, ctx.path ? { path: ctx.path } : {});
    }
  },
};

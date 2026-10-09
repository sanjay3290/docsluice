import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeReaderText, emitParagraph } from '../text-family.js';

interface Frame {
  value: unknown;
  path: string;
  index?: number;
  keys?: string[];
}

/** One JSON value per physical line; values are walked iteratively and never expanded. */
export const reader: Reader = {
  id: 'ndjson',
  mimeTypes: ['application/x-ndjson', 'application/ndjson', 'application/jsonlines'],
  // The common reader contract is async so readers can extract nested documents.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(ctx): Promise<void> {
    const text = decodeReaderText(ctx);
    if (text === undefined) return;
    const lines = text.split(/\r\n|\n|\r/);
    let record = 0;
    for (const line of lines) {
      ctx.budget.tick();
      if (line.trim() === '') continue;
      record++;
      if (!boundedJsonScan(line, ctx)) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        ctx.warnings.add({ code: 'UNREADABLE_PART', message: `NDJSON record ${record} is not valid JSON.` });
        continue;
      }
      const stack: Frame[] = [{ value, path: `record[${record}]` }];
      while (stack.length > 0) {
        ctx.budget.tick();
        const frame = stack[stack.length - 1]!;
        if (frame.value !== null && typeof frame.value === 'object') {
          if (Array.isArray(frame.value)) {
            frame.index ??= 0;
            if (frame.index >= frame.value.length) {
              stack.pop();
              continue;
            }
            const index = frame.index++;
            ctx.budget.tick();
            stack.push({
              value: frame.value[index],
              path: `${frame.path}[${index}]`,
            });
            continue;
          } else {
            const object = frame.value as Record<string, unknown>;
            frame.keys ??= Object.keys(object);
            frame.index ??= 0;
            if (frame.index >= frame.keys.length) {
              stack.pop();
              continue;
            }
            const key = frame.keys[frame.index++]!;
            ctx.budget.tick();
            stack.push({
              value: Object.getOwnPropertyDescriptor(object, key)?.value as unknown,
              path: `${frame.path}.${key}`,
            });
            continue;
          }
        }
        stack.pop();
        const scalar = typeof frame.value === 'string' ? frame.value : String(frame.value);
        if (!ctx.budget.addCells(1)) return;
        if (!emitParagraph(ctx, `${frame.path}: ${scalar}`, frame.path)) return;
      }
    }
  },
};

function boundedJsonScan(line: string, ctx: ReadContext): boolean {
  let entered = 0;
  let quoted = false;
  let escaped = false;
  try {
    for (let index = 0; index < line.length; index++) {
      ctx.budget.tick();
      const character = line[index]!;
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{' || character === '[') {
        let allowed: boolean;
        try {
          allowed = ctx.budget.enterDepth('block');
        } catch (error) {
          ctx.budget.exitDepth('block');
          throw error;
        }
        if (!allowed) {
          ctx.budget.exitDepth('block');
          return false;
        }
        entered++;
      } else if ((character === '}' || character === ']') && entered > 0) {
        ctx.budget.exitDepth('block');
        entered--;
      }
    }
    return true;
  } finally {
    while (entered > 0) {
      ctx.budget.exitDepth('block');
      entered--;
    }
  }
}

export default reader;

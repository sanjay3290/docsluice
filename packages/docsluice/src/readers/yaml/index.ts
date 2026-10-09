import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeReaderText, emitParagraph } from '../text-family.js';

/** A bounded, non-resolving subset reader for simple YAML mappings and sequences. */
export const reader: Reader = {
  id: 'yaml',
  mimeTypes: ['application/yaml', 'text/yaml', 'text/x-yaml'],
  // The common reader contract is async so readers can extract nested documents.
  // eslint-disable-next-line @typescript-eslint/require-await
  async read(ctx): Promise<void> {
    const text = decodeReaderText(ctx);
    if (text === undefined) return;
    const lines = text.split(/\r\n|\n|\r/);
    const parents: Array<{ indent: number; path: string }> = [];
    const indices = new Map<string, number>();
    let skippedIndent: number | undefined;
    try {
      for (const line of lines) {
        ctx.budget.tick();
        let cursor = 0;
        let indent = 0;
        while (cursor < line.length && (line[cursor] === ' ' || line[cursor] === '\t')) {
          ctx.budget.tick();
          indent += line[cursor] === '\t' ? 2 : 1;
          cursor++;
        }
        const content = line.slice(cursor).trim();
        if (content === '' || content === '---' || content === '...' || content.startsWith('#')) continue;
        if (skippedIndent !== undefined) {
          if (indent > skippedIndent) continue;
          skippedIndent = undefined;
        }
        while (parents.length > 0 && parents[parents.length - 1]!.indent >= indent) {
          parents.pop();
          ctx.budget.exitDepth('block');
        }
        let colon = -1;
        let quote = '';
        let escaped = false;
        for (let i = 0; i < content.length; i++) {
          ctx.budget.tick();
          const character = content[i]!;
          if (escaped) {
            escaped = false;
            continue;
          }
          if (quote === '"' && character === '\\') {
            escaped = true;
            continue;
          }
          if (quote !== '') {
            if (character === quote) quote = '';
            continue;
          }
          if (character === '"' || character === "'") {
            quote = character;
            continue;
          }
          if (character === ':') {
            colon = i;
            break;
          }
        }
        if (colon < 0) {
          const parent = parents[parents.length - 1]?.path ?? 'document';
          const index = indices.get(parent) ?? 0;
          indices.set(parent, index + 1);
          if (!ctx.budget.addCells(1)) return;
          if (!emitParagraph(ctx, `${parent}[${index}]: ${content}`, `${parent}[${index}]`)) return;
          continue;
        }
        let key = content.slice(0, colon).trim();
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))
          key = key.slice(1, -1);
        if (key.length === 0) key = '(empty-key)';
        const parent = parents[parents.length - 1]?.path;
        const path = parent === undefined ? key : `${parent}.${key}`;
        const rawValue = content.slice(colon + 1).trim();
        const value = stripComment(rawValue, ctx);
        if (value === '') {
          let entered: boolean;
          try {
            entered = ctx.budget.enterDepth('block');
          } catch (error) {
            ctx.budget.exitDepth('block');
            throw error;
          }
          if (!entered) {
            ctx.budget.exitDepth('block');
            skippedIndent = indent;
            continue;
          }
          parents.push({ indent, path });
          continue;
        }
        if (!ctx.budget.addCells(1)) return;
        if (!emitParagraph(ctx, `${path}: ${value}`, path)) return;
      }
    } finally {
      while (parents.length > 0) {
        parents.pop();
        ctx.budget.exitDepth('block');
      }
    }
  },
};

function stripComment(value: string, ctx: ReadContext): string {
  let quote = '';
  let escaped = false;
  for (let i = 0; i < value.length; i++) {
    ctx.budget.tick();
    const character = value[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\t'))
      return value.slice(0, i).trimEnd();
  }
  return value;
}

export default reader;

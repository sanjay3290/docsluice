import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';
import { isBlank, splitLines } from '../text-lines.js';

/** Inputs up to this size also get the whole source as a `yaml` code block. */
const SOURCE_MAX_BYTES = 64 * 1024;

/** One open mapping or sequence level: its indentation, its path, and the next sequence index. */
interface Level {
  indent: number;
  path: string;
  nextIndex: number;
}

function indentOf(line: string): number {
  let indent = 0;
  while (indent < line.length && line.charCodeAt(indent) === 0x20) indent++;
  return indent;
}

/** A path segment in the JSON reader's style: `.key`, or `["odd key"]`. */
function keySegment(key: string): string {
  let identifier = key.length > 0;
  for (let index = 0; index < key.length && identifier; index++) {
    const code = key.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
    identifier = letter || (index > 0 && ((code >= 48 && code <= 57) || code === 45));
  }
  return identifier ? `.${key}` : `[${JSON.stringify(key)}]`;
}

/** Strip a trailing ` # comment` outside quotes, then surrounding quotes from a plain scalar. */
function scalar(value: string): string {
  let quote = '';
  let end = value.length;
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      if (index === 0 || value[index - 1] === ' ') quote = char;
    } else if (char === '#' && (index === 0 || value[index - 1] === ' ' || value[index - 1] === '\t')) {
      end = index;
      break;
    }
  }
  const text = value.slice(0, end).trim();
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text.endsWith(first)) {
      const inner = text.slice(1, -1);
      return first === "'"
        ? inner.replaceAll("''", "'")
        : inner.replaceAll('\\"', '"').replaceAll('\\n', '\n');
    }
  }
  return text;
}

/**
 * Find the `key: value` separator: the first `:` followed by a space or the line end, outside
 * quotes and flow brackets. Returns -1 for a line that is not a mapping entry.
 */
function separator(text: string): number {
  let quote = '';
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if ((char === '"' || char === "'") && index === 0) quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth = Math.max(0, depth - 1);
    else if (char === '#' && index > 0 && text[index - 1] === ' ') return -1;
    else if (char === ':' && depth === 0 && (index + 1 === text.length || text[index + 1] === ' '))
      return index;
  }
  return -1;
}

/**
 * YAML reader without a YAML parser: block mappings and sequences become `path: value` paragraphs
 * in the JSON reader's path style, and small inputs also keep their source as a `yaml` code block.
 * Keys are kept as strings in an array, never as object keys (SEC-6); anchors, aliases and tags are
 * text and are never expanded, so an alias bomb stays as small as its source.
 */
export const yamlReader: Reader = {
  id: 'yaml',
  mimeTypes: ['application/yaml', 'application/x-yaml', 'text/yaml'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const lines = splitLines(text, ctx.budget);
    const maxDepth = ctx.budget.limits.blockDepth;
    let levels: Level[] = [{ indent: -1, path: '$', nextIndex: 0 }];
    let depthWarned = false;
    let emitted = 0;
    const emit = (path: string, value: string): boolean => {
      const locPath = ctx.path ? `${ctx.path}/${path}` : path;
      return ctx.out.paragraph(`${path}: ${value}`, { path: locPath });
    };
    const open = (indent: number, path: string): void => {
      if (levels.length > maxDepth) {
        if (!depthWarned) {
          depthWarned = true;
          ctx.warnings.add({
            code: 'DEPTH_LIMIT',
            message: `YAML nesting exceeded the block depth limit of ${maxDepth}; deeper keys keep the last path.`,
          });
        }
        return;
      }
      levels.push({ indent, path, nextIndex: 0 });
    };

    for (let index = 0; index < lines.length; index++) {
      ctx.budget.tick();
      const line = lines[index]!;
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('%')) continue;
      if (trimmed === '---' || trimmed === '...' || trimmed.startsWith('--- ')) {
        // A new document starts its paths again.
        levels = [{ indent: -1, path: '$', nextIndex: 0 }];
        continue;
      }
      let indent = indentOf(line);
      let body = line.slice(indent);
      while (levels.length > 1 && levels.at(-1)!.indent >= indent) levels.pop();
      let parent = levels.at(-1)!;
      // Sequence items: `- value`, `- key: value`, and `- - nested`.
      while (body === '-' || body.startsWith('- ')) {
        ctx.budget.tick();
        const itemPath = `${parent.path}[${parent.nextIndex++}]`;
        const rest = body.slice(1);
        const offset = indentOf(rest) + 1;
        indent += offset;
        body = body.slice(offset);
        open(indent - 1, itemPath);
        parent = levels.at(-1)!;
        // Past the depth limit the rest of the line is one value, so `- - - …` stays linear.
        if (body.length === 0 || depthWarned) break;
      }
      if (body.length === 0) continue;
      const colon = separator(body);
      if (colon < 0) {
        // A scalar sequence item or a line we do not model: it belongs to the current path.
        if (!emit(parent.path, scalar(body))) return;
        if (++emitted % 256 === 0) await ctx.out.flush();
        continue;
      }
      const key = scalar(body.slice(0, colon));
      const path = `${parent.path}${keySegment(key)}`;
      const rawValue = body.slice(colon + 1).trim();
      const value = scalar(rawValue);
      if (value === '|' || value === '>' || /^[|>][+-]?\d?$/.test(value)) {
        // Block scalar: the following lines indented deeper than the key.
        const parts: string[] = [];
        while (index + 1 < lines.length) {
          ctx.budget.tick();
          const next = lines[index + 1]!;
          if (!isBlank(next) && indentOf(next) <= indent) break;
          parts.push(next.trim());
          index++;
        }
        while (parts.length > 0 && parts.at(-1)!.length === 0) parts.pop();
        const joined = value.startsWith('|') ? parts.join('\n') : parts.join(' ').replaceAll('  ', '\n');
        if (!emit(path, joined)) return;
      } else if (value.length === 0 || (rawValue.startsWith('&') && !rawValue.includes(' '))) {
        // A mapping or sequence follows (an anchor on its own stays text in the next entries).
        open(indent, path);
        continue;
      } else if (!emit(path, value)) return;
      if (++emitted % 256 === 0) await ctx.out.flush();
    }
    if (ctx.bytes.length <= SOURCE_MAX_BYTES && text.trim().length > 0) {
      ctx.out.code(text, ctx.path ? { path: ctx.path } : {}, 'yaml');
    }
  },
};

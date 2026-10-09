import type { ReadContext, Reader } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';

const PRETTY_JSON_MAX_BYTES = 64 * 1024;
const PRETTY_JSON_MAX_STAGED_CHARS = 1_000_000;

interface PathNode {
  parent?: PathNode;
  segment: string;
}

interface ValueFrame {
  value: unknown;
  path: PathNode;
  initialized: boolean;
  isArray: boolean;
  keys?: string[];
  nextIndex: number;
}

/** Guard JSON.parse with an iterative nesting scan so hostile depth never reaches its recursive parser. */
function withinBlockDepth(text: string, ctx: ReadContext): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  try {
    for (let index = 0; index < text.length; index += 1) {
      ctx.budget.tick();
      const code = text.charCodeAt(index);
      if (inString) {
        if (escaped) escaped = false;
        else if (code === 92) escaped = true;
        else if (code === 34) inString = false;
        continue;
      }
      if (code === 34) {
        inString = true;
      } else if (code === 123 || code === 91) {
        let entered: boolean;
        try {
          entered = ctx.budget.enterDepth('block');
        } catch (error) {
          ctx.budget.exitDepth('block');
          throw error;
        }
        if (!entered) {
          ctx.budget.exitDepth('block');
          ctx.warnings.add({
            code: 'DEPTH_LIMIT',
            message: `JSON nesting exceeded the block depth limit of ${ctx.budget.limits.blockDepth}.`,
          });
          return false;
        }
        depth += 1;
      } else if ((code === 125 || code === 93) && depth > 0) {
        ctx.budget.exitDepth('block');
        depth -= 1;
      }
    }
    return true;
  } finally {
    while (depth > 0) {
      ctx.budget.exitDepth('block');
      depth -= 1;
    }
  }
}

function propertySegment(key: string, ctx: ReadContext): string | undefined {
  if (!ctx.budget.checkOutputChars(key.length + 3)) return undefined;
  let identifier = key.length > 0;
  for (let index = 0; index < key.length; index += 1) {
    ctx.budget.tick();
    const code = key.charCodeAt(index);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 36;
    const digit = code >= 48 && code <= 57;
    if (!(letter || (index > 0 && digit))) {
      identifier = false;
      break;
    }
  }
  if (identifier) return `.${key}`;
  return `[${JSON.stringify(key)}]`;
}

function formatPath(node: PathNode, ctx: ReadContext): string | undefined {
  const segments: string[] = [];
  let length = 0;
  let current: PathNode | undefined = node;
  while (current) {
    ctx.budget.tick();
    length += current.segment.length;
    if (!ctx.budget.checkOutputChars(length + 2)) return undefined;
    segments.push(current.segment);
    current = current.parent;
  }
  return segments.reverse().join('');
}

function scalarText(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

interface PrettyFrame {
  value: unknown;
  depth: number;
  initialized: boolean;
  waiting: boolean;
  isArray: boolean;
  keys?: string[];
  nextIndex: number;
}

/** Format JSON with an explicit work stack, avoiding recursive stringify on file data. */
function prettyJson(root: unknown, ctx: ReadContext): string | undefined {
  const output: string[] = [];
  const work: PrettyFrame[] = [
    { value: root, depth: 0, initialized: false, waiting: false, isArray: false, nextIndex: 0 },
  ];
  let stagedChars = 0;
  const append = (value: string): boolean => {
    ctx.budget.tick();
    const next = stagedChars + value.length;
    if (next > PRETTY_JSON_MAX_STAGED_CHARS) return false;
    if (!ctx.budget.checkOutputChars(next)) return false;
    stagedChars = next;
    output.push(value);
    return true;
  };
  const childCount = (frame: PrettyFrame): number =>
    frame.isArray ? (frame.value as unknown[]).length : frame.keys!.length;
  const pushChild = (frame: PrettyFrame): boolean => {
    const index = frame.nextIndex++;
    if (!append(`\n${'  '.repeat(frame.depth + 1)}`)) return false;
    let child: unknown;
    if (frame.isArray) {
      child = (frame.value as unknown[]).at(index);
    } else {
      const key = frame.keys![index]!;
      if (!append(`${JSON.stringify(key)}: `)) return false;
      child = Reflect.get(frame.value as object, key) as unknown;
    }
    frame.waiting = true;
    work.push({
      value: child,
      depth: frame.depth + 1,
      initialized: false,
      waiting: false,
      isArray: false,
      nextIndex: 0,
    });
    return true;
  };

  while (work.length > 0) {
    ctx.budget.tick();
    const frame = work[work.length - 1]!;
    if (frame.waiting) {
      frame.waiting = false;
      if (frame.nextIndex >= childCount(frame)) {
        if (!append(`\n${'  '.repeat(frame.depth)}${frame.isArray ? ']' : '}'}`)) return undefined;
        work.pop();
        continue;
      }
      if (!append(',')) return undefined;
      if (!pushChild(frame)) return undefined;
      continue;
    }
    const value = frame.value;
    if (value === null || typeof value !== 'object') {
      if (!append(JSON.stringify(value))) return undefined;
      work.pop();
      continue;
    }
    if (!frame.initialized) {
      frame.initialized = true;
      frame.isArray = Array.isArray(value);
      if (!frame.isArray) {
        frame.keys = [];
        for (const key of Object.keys(value)) {
          ctx.budget.tick();
          frame.keys.push(key);
        }
      }
      const count = childCount(frame);
      if (!append(frame.isArray ? '[' : '{')) return undefined;
      if (count === 0) {
        if (!append(frame.isArray ? ']' : '}')) return undefined;
        work.pop();
        continue;
      }
      if (!pushChild(frame)) return undefined;
      continue;
    }
    // A container frame is resumed only after its single current child returns.
    return undefined;
  }
  return output.join('');
}

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

    const stack: ValueFrame[] = [
      { value: root, path: { segment: '$' }, initialized: false, isArray: false, nextIndex: 0 },
    ];
    while (stack.length > 0) {
      ctx.budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.value === null || typeof frame.value !== 'object') {
        const framePath = formatPath(frame.path, ctx);
        if (framePath === undefined) return;
        const locPath = ctx.path ? `${ctx.path}/${framePath}` : framePath;
        stack.pop();
        if (!ctx.out.paragraph(`${framePath}: ${scalarText(frame.value)}`, { path: locPath })) return;
        continue;
      }
      if (!frame.initialized) {
        frame.initialized = true;
        frame.isArray = Array.isArray(frame.value);
        if (!frame.isArray) frame.keys = Object.keys(frame.value);
      }
      const count = frame.isArray ? (frame.value as unknown[]).length : frame.keys!.length;
      if (frame.nextIndex >= count) {
        stack.pop();
        continue;
      }
      const index = frame.nextIndex++;
      let value: unknown;
      let segment: string;
      if (frame.isArray) {
        value = (frame.value as unknown[]).at(index);
        segment = `[${index}]`;
      } else {
        const key = frame.keys![index]!;
        value = Reflect.get(frame.value, key) as unknown;
        const property = propertySegment(key, ctx);
        if (property === undefined) return;
        segment = property;
      }
      stack.push({
        value,
        path: { parent: frame.path, segment },
        initialized: false,
        isArray: false,
        nextIndex: 0,
      });
    }

    if (ctx.bytes.length < PRETTY_JSON_MAX_BYTES) {
      const pretty = prettyJson(root, ctx);
      if (pretty !== undefined) ctx.out.code(pretty, ctx.path ? { path: ctx.path } : {});
    }
  },
};

import type { DocsluiceDocument } from '../core/model.js';
import { Budget } from '../core/budget.js';
import { LimitExceededError } from '../core/errors.js';
import { DEFAULT_LIMITS } from '../core/limits.js';

/** Options for the deterministic document JSON renderer. */
export interface ToJSONOptions {
  /** Indentation, with the same truncation rules as `JSON.stringify`. */
  space?: number | string;
  /** Replace the nondeterministic extraction duration with zero. */
  stable?: boolean;
  /** Include raw child bytes as base64. Bytes are omitted by default. */
  bytes?: 'base64';
}

type Context =
  | 'root'
  | 'metadata'
  | 'features'
  | 'stats'
  | 'block'
  | 'listItem'
  | 'cell'
  | 'run'
  | 'location'
  | 'child'
  | 'warning'
  | 'warningError'
  | 'custom';

type Task =
  | { kind: 'value'; value: unknown; context: Context; depth: number; childDepthGuard?: boolean }
  | { kind: 'arrayFrame'; value: unknown[]; context: Context; depth: number; index: number }
  | { kind: 'text'; value: string }
  | { kind: 'exitObject'; value: object; depthKind?: 'block' | 'child' };

const ROOT_FIELDS = [
  'format',
  'mimeType',
  'encoding',
  'metadata',
  'features',
  'blocks',
  'children',
  'warnings',
  'stats',
];
const FIELD_ORDERS = new Map<Context, readonly string[]>([
  ['root', ROOT_FIELDS],
  ['metadata', ['title', 'authors', 'created', 'modified', 'pageCount', 'language', 'custom']],
  ['features', ['hasMacros', 'hasExternalLinks', 'hasEmbeddedFiles', 'isEncrypted', 'hasJavaScript']],
  ['stats', ['bytesRead', 'durationMs', 'truncated', 'needsOcr']],
  ['block', []],
  ['listItem', ['text', 'marker', 'items']],
  ['cell', ['text', 'raw', 'formula', 'rowSpan', 'colSpan', 'address', 'hidden']],
  ['run', ['text', 'bold', 'italic', 'code', 'href']],
  ['location', ['page', 'pageLabel', 'slide', 'sheet', 'range', 'path', 'offset']],
  ['child', ['path', 'name', 'status', 'sizeBytes', 'mimeType', 'document', 'bytes', 'error']],
  ['warning', ['code', 'message', 'loc']],
  ['warningError', ['code', 'message']],
  ['custom', ['name', 'value']],
]);

const BLOCK_FIELDS = new Map<string, readonly string[]>([
  ['heading', ['kind', 'level', 'text', 'loc']],
  ['paragraph', ['kind', 'text', 'runs', 'loc']],
  ['list', ['kind', 'ordered', 'items', 'loc']],
  ['table', ['kind', 'rows', 'headerRows', 'caption', 'loc']],
  ['code', ['kind', 'language', 'text', 'loc']],
  ['image', ['kind', 'alt', 'mimeType', 'ref', 'width', 'height', 'loc']],
  ['note', ['kind', 'role', 'text', 'author', 'loc']],
  ['header', ['kind', 'text', 'loc']],
  ['footer', ['kind', 'text', 'loc']],
  ['section', ['kind', 'role', 'title', 'hidden', 'needsOcr', 'blocks', 'loc']],
]);

function fields(
  value: object,
  context: Context,
  options: ToJSONOptions,
  budget: Budget,
): Array<[string, unknown, Context]> {
  let order = FIELD_ORDERS.get(context)!;
  if (context === 'block') {
    const kind = Object.getOwnPropertyDescriptor(value, 'kind')?.value as unknown;
    order = typeof kind === 'string' ? (BLOCK_FIELDS.get(kind) ?? []) : [];
  }

  const result: Array<[string, unknown, Context]> = [];
  for (const key of order) {
    budget.tick();
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    let item = Object.getOwnPropertyDescriptor(value, key)?.value as unknown;
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    if (context === 'child' && key === 'bytes' && item instanceof Uint8Array && options.bytes !== 'base64')
      continue;
    if (context === 'stats' && key === 'durationMs' && options.stable === true) item = 0;
    result.push([key, item, fieldContext(context, key)]);
  }
  return result;
}

function fieldContext(context: Context, key: string): Context {
  switch (context) {
    case 'root':
      switch (key) {
        case 'metadata':
          return 'metadata';
        case 'features':
          return 'features';
        case 'stats':
          return 'stats';
        case 'blocks':
          return 'block';
        case 'children':
          return 'child';
        case 'warnings':
          return 'warning';
        default:
          return 'root';
      }
    case 'metadata':
      return key === 'custom' ? 'custom' : 'metadata';
    case 'block':
      switch (key) {
        case 'loc':
          return 'location';
        case 'runs':
          return 'run';
        case 'items':
          return 'listItem';
        case 'rows':
          return 'cell';
        case 'blocks':
          return 'block';
        default:
          return 'block';
      }
    case 'listItem':
      return key === 'items' ? 'listItem' : 'listItem';
    case 'child':
      if (key === 'document') return 'root';
      if (key === 'error') return 'warningError';
      return 'child';
    case 'warning':
      return key === 'loc' ? 'location' : 'warning';
    default:
      return context;
  }
}

function arrayItemContext(context: Context): Context {
  return context;
}

function indentation(space: ToJSONOptions['space']): string {
  if (typeof space === 'number') return ' '.repeat(Math.max(0, Math.min(10, Math.floor(space))));
  return typeof space === 'string' ? space.slice(0, 10) : '';
}

const ENCODED_CHUNK_SIZE = 8192;

function encodeBase64(bytes: Uint8Array, budget: Budget, write: (chunk: string) => void): void {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const decoder = new TextDecoder();
  const characters = new Uint8Array(ENCODED_CHUNK_SIZE);
  let written = 0;
  for (let i = 0; i < bytes.length; i += 3) {
    budget.tick();
    const first = bytes[i]!;
    const hasSecond = i + 1 < bytes.length;
    const hasThird = i + 2 < bytes.length;
    const second = hasSecond ? bytes[i + 1]! : 0;
    const third = hasThird ? bytes[i + 2]! : 0;
    characters[written++] = alphabet.charCodeAt(first >>> 2);
    characters[written++] = alphabet.charCodeAt(((first & 3) << 4) | (second >>> 4));
    characters[written++] = hasSecond ? alphabet.charCodeAt(((second & 15) << 2) | (third >>> 6)) : 61;
    characters[written++] = hasThird ? alphabet.charCodeAt(third & 63) : 61;
    if (written === ENCODED_CHUNK_SIZE) {
      write(decoder.decode(characters));
      written = 0;
    }
  }
  if (written > 0) write(decoder.decode(characters.subarray(0, written)));
}

/** Render a document as JSON in the model's fixed field order. */
export function toJSON(doc: DocsluiceDocument, options: ToJSONOptions = {}): string {
  return serializeJSON(doc, options, new Budget(DEFAULT_LIMITS, { onLimit: 'throw' }));
}

function serializeJSON(doc: DocsluiceDocument, options: ToJSONOptions, budget: Budget): string {
  const indent = indentation(options.space);
  const output: string[] = [];
  let pending = '';
  const active = new WeakSet<object>();
  const tasks: Task[] = [{ kind: 'value', value: doc, context: 'root', depth: 0 }];

  function append(value: string): void {
    budget.addOutputChars(value.length);
    if (pending.length + value.length > ENCODED_CHUNK_SIZE) {
      output.push(pending);
      pending = '';
    }
    if (value.length >= ENCODED_CHUNK_SIZE) output.push(value);
    else pending += value;
  }

  function appendJSONString(value: string): void {
    budget.checkOutputChars(value.length + 2);
    append('"');
    let chunk = '';

    function add(part: string): void {
      if (chunk.length + part.length > ENCODED_CHUNK_SIZE) {
        append(chunk);
        chunk = '';
      }
      chunk += part;
      if (chunk.length >= ENCODED_CHUNK_SIZE) {
        append(chunk);
        chunk = '';
      }
    }

    for (let i = 0; i < value.length; i++) {
      budget.tick();
      const code = value.charCodeAt(i);
      switch (code) {
        case 0x22:
          add('\\"');
          continue;
        case 0x5c:
          add('\\\\');
          continue;
        case 0x08:
          add('\\b');
          continue;
        case 0x09:
          add('\\t');
          continue;
        case 0x0a:
          add('\\n');
          continue;
        case 0x0c:
          add('\\f');
          continue;
        case 0x0d:
          add('\\r');
          continue;
      }
      if (code < 0x20) {
        add(`\\u00${code.toString(16).padStart(2, '0')}`);
        continue;
      }
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          add(value.slice(i, i + 2));
          i++;
        } else {
          add(`\\u${code.toString(16)}`);
        }
        continue;
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        add(`\\u${code.toString(16)}`);
        continue;
      }
      add(value[i]!);
    }
    if (chunk.length > 0) append(chunk);
    append('"');
  }

  while (tasks.length > 0) {
    budget.tick();
    const task = tasks.pop()!;
    if (task.kind === 'text') {
      append(task.value);
      continue;
    }
    if (task.kind === 'exitObject') {
      if (task.depthKind) budget.exitDepth(task.depthKind);
      active.delete(task.value);
      continue;
    }
    if (task.kind === 'arrayFrame') {
      if (task.index === task.value.length) {
        append(indent ? `\n${indent.repeat(task.depth)}]` : ']');
        continue;
      }
      if (task.index > 0) append(',');
      if (indent) append(`\n${indent.repeat(task.depth + 1)}`);
      tasks.push({ ...task, index: task.index + 1 });
      tasks.push({
        kind: 'value',
        value: task.value[task.index],
        context: arrayItemContext(task.context),
        depth: task.depth + 1,
      });
      continue;
    }

    const value = task.value;
    if (value instanceof Uint8Array) {
      if (options.bytes === 'base64') {
        const encodedLength = Math.ceil(value.length / 3) * 4;
        budget.checkOutputChars(encodedLength + 2);
        append('"');
        encodeBase64(value, budget, append);
        append('"');
      } else {
        append('null');
      }
      continue;
    }
    if (typeof value === 'string') {
      appendJSONString(value);
      continue;
    }
    if (value === null || typeof value !== 'object') {
      append(JSON.stringify(value) ?? 'null');
      continue;
    }

    if (active.has(value)) throw new TypeError('Cannot serialize cyclic document data.');
    active.add(value);

    let depthKind: 'block' | 'child' | undefined;
    if (task.childDepthGuard) {
      if (!budget.enterDepth('child')) throw new LimitExceededError('childDepth', budget.limits.childDepth);
      depthKind = 'child';
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        append('[]');
        if (depthKind) budget.exitDepth(depthKind);
        active.delete(value);
        continue;
      }
      append('[');
      tasks.push({ kind: 'exitObject', value, depthKind });
      tasks.push({ kind: 'arrayFrame', value, context: task.context, depth: task.depth, index: 0 });
      continue;
    }

    const blockKind =
      task.context === 'block'
        ? (Object.getOwnPropertyDescriptor(value, 'kind')?.value as unknown)
        : undefined;
    if (task.context === 'listItem' || blockKind === 'section') {
      if (!budget.enterDepth('block')) throw new LimitExceededError('blockDepth', budget.limits.blockDepth);
      depthKind = 'block';
    } else if (task.context === 'cell') {
      budget.addCells(1);
    }

    const objectFields = fields(value, task.context, options, budget);
    if (objectFields.length === 0) {
      if (depthKind) budget.exitDepth(depthKind);
      append('{}');
      active.delete(value);
      continue;
    }
    append('{');
    tasks.push({ kind: 'exitObject', value, depthKind });
    tasks.push({ kind: 'text', value: indent ? `\n${indent.repeat(task.depth)}}` : '}' });
    for (let i = objectFields.length - 1; i >= 0; i--) {
      budget.tick();
      const [key, item, context] = objectFields[i]!;
      tasks.push({
        kind: 'value',
        value: item,
        context,
        depth: task.depth + 1,
        childDepthGuard: task.context === 'child' && key === 'document',
      });
      tasks.push({ kind: 'text', value: indent ? ': ' : ':' });
      tasks.push({ kind: 'text', value: JSON.stringify(key) });
      if (i > 0 && indent) tasks.push({ kind: 'text', value: `\n${indent.repeat(task.depth + 1)}` });
      if (i > 0) tasks.push({ kind: 'text', value: ',' });
      if (i === 0 && indent) tasks.push({ kind: 'text', value: `\n${indent.repeat(task.depth + 1)}` });
    }
  }

  if (pending.length > 0) output.push(pending);
  return output.join('');
}

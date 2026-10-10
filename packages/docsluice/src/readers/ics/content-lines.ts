import type { Budget } from '../../core/budget.js';

/** One content line ([RFC 5545] 3.1, [RFC 6350] 3.3): name, parameters (as pairs) and raw value. */
export interface ContentLine {
  name: string;
  params: Array<[string, string]>;
  value: string;
}

/** One `BEGIN:…`/`END:…` component with its own lines; nested components are listed separately. */
export interface Component {
  name: string;
  lines: ContentLine[];
  /** Names of the enclosing components, outermost first. */
  parents: string[];
}

/**
 * Unfold and split content lines: a line that starts with a space or tab continues the previous one.
 * Returns the components in order of their `BEGIN`, each with only its direct lines. Components are
 * tracked with an explicit stack bounded by `blockDepth`; deeper ones are flattened into their parent.
 */
export function parseComponents(
  text: string,
  budget: Budget,
): { components: Component[]; depthLimited: boolean } {
  const components: Component[] = [];
  const stack: Component[] = [];
  let depthLimited = false;
  let ignoredDepth = 0;
  let current = '';
  const flush = (): void => {
    if (current.length === 0) return;
    const line = parseLine(current, budget);
    current = '';
    if (!line) return;
    if (line.name === 'BEGIN') {
      if (stack.length >= budget.limits.blockDepth) {
        depthLimited = true;
        ignoredDepth++;
        return;
      }
      const component: Component = {
        name: line.value.toUpperCase(),
        lines: [],
        parents: stack.map((open) => open.name),
      };
      components.push(component);
      stack.push(component);
    } else if (line.name === 'END') {
      if (ignoredDepth > 0) ignoredDepth--;
      else stack.pop();
    } else {
      stack.at(-1)?.lines.push(line);
    }
  };
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    const code = text.charCodeAt(index);
    if (index < text.length && code !== 0x0a && code !== 0x0d) {
      if ((index & 0xfff) === 0) budget.tick();
      continue;
    }
    budget.tick();
    const physical = text.slice(start, index);
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index++;
    start = index + 1;
    const first = physical.charCodeAt(0);
    if (first === 0x20 || first === 0x09) current += physical.slice(1);
    else {
      flush();
      current = physical;
    }
  }
  flush();
  return { components, depthLimited };
}

/** `NAME;PARAM=value;PARAM="quoted":value`. A line without a colon is not a content line. */
function parseLine(line: string, budget: Budget): ContentLine | undefined {
  let index = 0;
  let quoted = false;
  const separators: number[] = [];
  for (; index < line.length; index++) {
    if ((index & 0xfff) === 0) budget.tick();
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ';') separators.push(index);
    else if (!quoted && char === ':') break;
  }
  if (index >= line.length) return undefined;
  const nameEnd = separators[0] ?? index;
  const name = line.slice(0, nameEnd).trim().toUpperCase();
  if (name.length === 0) return undefined;
  // The group prefix (`item1.EMAIL`, RFC 6350 3.3) is dropped.
  const dot = name.lastIndexOf('.');
  const params: Array<[string, string]> = [];
  for (let at = 0; at < separators.length; at++) {
    const part = line.slice(separators[at]! + 1, separators[at + 1] ?? index);
    const equals = part.indexOf('=');
    if (equals < 0) continue;
    let value = part.slice(equals + 1);
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    params.push([part.slice(0, equals).trim().toUpperCase(), value]);
  }
  return { name: dot >= 0 ? name.slice(dot + 1) : name, params, value: line.slice(index + 1) };
}

/** A TEXT value with its escapes decoded: `\\n`, `\\N`, `\\,`, `\;` and `\\\\`. */
export function unescapeText(value: string): string {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char !== '\\' || index + 1 === value.length) {
      out += char;
      continue;
    }
    const next = value[++index]!;
    out += next === 'n' || next === 'N' ? '\n' : next;
  }
  return out;
}

/** The first value of a parameter, case-insensitively by name. */
export function param(line: ContentLine, name: string): string | undefined {
  for (const [key, value] of line.params) if (key === name) return value;
  return undefined;
}

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Issue #240: `String.raw` keeps `\u` escapes as text under the Vitest transform. The escapes that
// looked "cooked" had been turned into characters by the tool that wrote the test file, before
// Vitest ever saw it. This guard catches that: a String.raw template holding a non-ASCII character
// almost always means an escape was decoded on the way into the file.
const root = new URL('./', import.meta.url);

function sources(): string[] {
  return readdirSync(root, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

describe('String.raw in test sources (#240)', () => {
  it('keeps \\u escapes as text', () => {
    const escape = String.raw`\u0041`;
    expect(escape).toHaveLength(6);
    expect(escape.charCodeAt(0)).toBe(0x5c);
    expect(String.raw`{\rtf1 \u9731?}`).toBe('{\\rtf1 \\u9731?}');
  });

  it('has no String.raw template with a non-ASCII character', () => {
    const offenders: string[] = [];
    for (const name of sources()) {
      const text = readFileSync(new URL(name, root), 'utf8');
      let at = text.indexOf('String.raw`');
      while (at >= 0) {
        const start = at + 'String.raw`'.length;
        const end = text.indexOf('`', start);
        const body = text.slice(start, end < 0 ? text.length : end);
        for (let index = 0; index < body.length; index++) {
          if (body.charCodeAt(index) > 0x7e) {
            offenders.push(`${name}:${text.slice(0, start).split('\n').length}`);
            break;
          }
        }
        at = end < 0 ? -1 : text.indexOf('String.raw`', end + 1);
      }
    }
    expect(offenders).toEqual([]);
  });
});

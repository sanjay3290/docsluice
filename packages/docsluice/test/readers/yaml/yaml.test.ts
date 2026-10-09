import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../src/core/budget.js';
import reader from '../../../src/readers/yaml/index.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { parse } from '../text-family/harness.js';

describe('YAML reader', () => {
  it('emits scalar mapping paths and leaves aliases inert', async () => {
    const { doc } = await parse(
      reader,
      'name: Example\nchild:\n  value: 3\n  alias: *missing\nanchor: &x value\n',
    );
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'name: Example', loc: { path: 'name' } },
      { kind: 'paragraph', text: 'child.value: 3', loc: { path: 'child.value' } },
      { kind: 'paragraph', text: 'child.alias: *missing', loc: { path: 'child.alias' } },
      { kind: 'paragraph', text: 'anchor: &x value', loc: { path: 'anchor' } },
    ]);
  });

  it('bounds deep mappings and never places source keys in object properties', async () => {
    const deep = Array.from({ length: 20 }, (_, index) => `${'  '.repeat(index)}key${index}:`).join('\n');
    const source = `__proto__: polluted\n${deep}`;
    const { doc, warnings } = await parse(reader, source, { limits: { blockDepth: 8 } });
    expect(JSON.stringify(doc)).toContain('__proto__: polluted');
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('charges scalar nodes against the shared cell budget', async () => {
    const { doc, warnings } = await parse(reader, 'a: first\nb: second', { limits: { cells: 1 } });
    expect(doc.blocks).toHaveLength(1);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('preserves recursive aliases as inert text', async () => {
    const { doc } = await parse(reader, 'root: &root [*root, *root, *root]\ncopy: *root');
    expect(doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'root: &root [*root, *root, *root]' },
      { kind: 'paragraph', text: 'copy: *root' },
    ]);
  });

  it('uses the shared depth budget in truncate and throw modes and balances depth on throw', async () => {
    const { budget, warnings } = await parse(reader, 'outer:\n  inner:\n    value: stop', {
      limits: { blockDepth: 1 },
    });
    expect(budget.truncated).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');

    let thrownBudget: Budget | undefined;
    const thrown = await parse(reader, 'outer:\n  inner:\n    value: stop', {
      limits: { blockDepth: 1 },
      onLimit: 'throw',
      captureContext: (ctx) => {
        thrownBudget = ctx.budget;
      },
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(LimitExceededError);
    expect(thrownBudget?.enterDepth('block')).toBe(true);
    thrownBudget?.exitDepth('block');
  });

  it('skips an entire over-depth mapping subtree and resumes at its sibling', async () => {
    const { doc } = await parse(
      reader,
      'a:\n  b:\n    c:\n      d: secret\n    sibling: allowed\nnext: visible',
      { limits: { blockDepth: 2 } },
    );
    const blocks = doc.blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''));
    expect(blocks).not.toContain('a.b.c.d: secret');
    expect(blocks.join('\n')).not.toContain('secret');
    expect(blocks).toContain('a.b.sibling: allowed');
    expect(blocks).toContain('next: visible');
  });

  it('keeps quoted colons and hashes intact while stripping plain comments', async () => {
    const { doc } = await parse(
      reader,
      '"a:b":\n  "space key": "value: # literal" # remove this\n  single: \'text # literal\' # remove this too\n  plain: hash#inside\n  escaped: "say \\"hi\\" # quoted" # comment\n  "": empty-key-value',
    );
    expect(doc.blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      'a:b.space key: "value: # literal"',
      "a:b.single: 'text # literal'",
      'a:b.plain: hash#inside',
      'a:b.escaped: "say \\"hi\\" # quoted"',
      'a:b.(empty-key): empty-key-value',
    ]);
  });

  it('keeps sequence scalar paths stable across tabs, indentation changes, and unusual keys', async () => {
    const { doc } = await parse(
      reader,
      'root:\n\t"key.with.dots":\n\t\t- first\n\t\t- \'two: parts\'\n\tother: sibling',
    );
    expect(
      doc.blocks.map((block) => (block.kind === 'paragraph' ? [block.text, block.loc.path] : null)),
    ).toEqual([
      ['root.key.with.dots[0]: - first', 'root.key.with.dots[0]'],
      ["root.key.with.dots[1]: - 'two: parts'", 'root.key.with.dots[1]'],
      ['root.other: sibling', 'root.other'],
    ]);
  });

  it('handles escaped quotes inside quoted mapping keys before finding the key separator', async () => {
    const { doc } = await parse(reader, String.raw`"escaped \" key": value`);
    expect(doc.blocks).toMatchObject([
      {
        kind: 'paragraph',
        text: String.raw`escaped \" key: value`,
        loc: { path: String.raw`escaped \" key` },
      },
    ]);
  });

  it('decodes BOM-marked UTF-16 input and honors a zero output allowance', async () => {
    const source = 'label: café';
    const utf16 = new Uint8Array(2 + source.length * 2);
    utf16.set([0xff, 0xfe]);
    for (let index = 0; index < source.length; index++) {
      const code = source.charCodeAt(index);
      utf16[2 + index * 2] = code & 0xff;
      utf16[3 + index * 2] = code >> 8;
    }
    const decoded = await parse(reader, utf16);
    expect(decoded.doc.encoding).toBe('utf-16le');
    expect(decoded.doc.blocks).toMatchObject([{ kind: 'paragraph', text: 'label: café' }]);

    const empty = await parse(reader, 'secret: not emitted', { limits: { outputChars: 0 } });
    expect(empty.doc.blocks).toEqual([]);
    expect(empty.doc.stats.truncated).toBe(true);
    expect(empty.budget.depth).toBe(0);
  });
});

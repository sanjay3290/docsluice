import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import reader from '../../../src/readers/json/index.js';

async function parse(
  source: string,
  limits: Record<string, number> = {},
  onLimit: 'truncate' | 'throw' = 'truncate',
) {
  const bytes = new TextEncoder().encode(source);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings, onLimit });
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder('json', 'application/json', budget, options);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

describe('JSON reader', () => {
  it('emits scalar leaves in stable paths and pretty-prints small valid input', async () => {
    const { doc } = await parse('{"items":[{"name":"one"},true,4.5],"empty":null}');
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', text: '$.items[0].name: one', loc: { path: '$.items[0].name' } },
      { kind: 'paragraph', text: '$.items[1]: true', loc: { path: '$.items[1]' } },
      { kind: 'paragraph', text: '$.items[2]: 4.5', loc: { path: '$.items[2]' } },
      { kind: 'paragraph', text: '$.empty: null', loc: { path: '$.empty' } },
      {
        kind: 'code',
        text: '{\n  "items": [\n    {\n      "name": "one"\n    },\n    true,\n    4.5\n  ],\n  "empty": null\n}',
        loc: {},
      },
    ]);
  });

  it('uses quoted bracket paths for object keys that are not identifiers', async () => {
    const { doc } = await parse('{"display.name":"visible"}');
    expect(doc.blocks[0]).toEqual({
      kind: 'paragraph',
      text: '$["display.name"]: visible',
      loc: { path: '$["display.name"]' },
    });
  });

  it('extracts dangerous-looking keys as data without changing Object.prototype', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const { doc } = await parse('{"__proto__":{"polluted":"no"},"constructor":"literal","prototype":"kept"}');
    expect(doc.blocks.slice(0, 3).map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      '$.__proto__.polluted: no',
      '$.constructor: literal',
      '$.prototype: kept',
    ]);
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it('stops before parsing nesting beyond blockDepth and reports DEPTH_LIMIT', async () => {
    const { doc, warnings } = await parse(`${'['.repeat(100_000)}0${']'.repeat(100_000)}`, { blockDepth: 8 });
    expect(doc.blocks).toEqual([]);
    expect(warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });

  it('throws when JSON nesting exceeds blockDepth under onLimit throw', async () => {
    await expect(parse('[[[0]]]', { blockDepth: 1 }, 'throw')).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      limit: 'blockDepth',
    });
  });

  it('does not emit document content in malformed JSON warnings', async () => {
    const { warnings } = await parse('{"secret":"NEVER-LEAK",');
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(warnings)).not.toContain('NEVER-LEAK');
  });

  it('bounds emitted scalar text through the shared output budget', async () => {
    const { doc, warnings } = await parse(JSON.stringify({ value: 'x'.repeat(200) }), { outputChars: 12 });
    expect(doc.stats.truncated).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(JSON.stringify(warnings)).not.toContain('xxx');
  });

  it('omits a small-input pretty view whose expanded indentation exceeds its staging cap', async () => {
    const source = `${'['.repeat(1000)}[]${']'.repeat(1000)}`;
    const { doc, warnings } = await parse(source, { blockDepth: 1001, outputChars: 2_000_000_000 });
    expect(doc.blocks).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('checks cancellation during the bounded source scan', async () => {
    const bytes = new TextEncoder().encode('{"value":"secret"}');
    const controller = new AbortController();
    controller.abort('stop');
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits(), { warnings, signal: controller.signal });
    const options = { limits: budget.limits, runs: false } as ResolvedOptions;
    const out = new DocBuilder('json', 'application/json', budget, options);
    const ctx = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    await expect(reader.read(ctx)).rejects.toMatchObject({ code: 'ABORTED' });
  });
  it('bounds path staging and prefixes the optional code view for a child', async () => {
    const large = await parse(JSON.stringify({ ['x'.repeat(100_000)]: 'value' }), { outputChars: 4 });
    expect(large.doc.stats.truncated).toBe(true);
    expect(large.doc.blocks).toEqual([]);
    const budget = new Budget(resolveLimits());
    const out = new DocBuilder('json', 'application/json', budget);
    await reader.read({
      bytes: new TextEncoder().encode('{"a":1}'),
      options: { limits: budget.limits } as ResolvedOptions,
      budget,
      warnings: budget.warnings,
      out,
      path: 'archive/data.json',
      extractChild: async () => {},
    });
    expect(out.finish().blocks).toMatchObject([
      { loc: { path: 'archive/data.json#$.a' } },
      { kind: 'code', loc: { path: 'archive/data.json' } },
    ]);
  });
});

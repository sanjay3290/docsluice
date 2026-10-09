import { describe, expect, it } from 'vitest';
import type { Budget } from '../../../src/core/budget.js';
import reader from '../../../src/readers/ndjson/index.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { parse } from '../text-family/harness.js';

describe('NDJSON reader', () => {
  it('emits each record scalar with a stable record path', async () => {
    const { doc } = await parse(reader, '{"name":"Ada","items":[1,true,null]}\n["x",2]\n');
    expect(
      doc.blocks.map((block) => (block.kind === 'paragraph' ? [block.text, block.loc.path] : null)),
    ).toEqual([
      ['record[1].name: Ada', 'record[1].name'],
      ['record[1].items[0]: 1', 'record[1].items[0]'],
      ['record[1].items[1]: true', 'record[1].items[1]'],
      ['record[1].items[2]: null', 'record[1].items[2]'],
      ['record[2][0]: x', 'record[2][0]'],
      ['record[2][1]: 2', 'record[2][1]'],
    ]);
  });

  it('does not overflow on deeply nested records and truncates at output limits', async () => {
    const deep = `${'['.repeat(1_000)}0${']'.repeat(1_000)}`;
    const { warnings } = await parse(reader, `${deep}\n{"ok":"yes"}`, {
      limits: { blockDepth: 16, outputChars: 4 },
    });
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every(({ message }) => !message.includes('yes'))).toBe(true);
  });

  it('stops emitting scalar leaves at the shared cell budget', async () => {
    const { doc, warnings } = await parse(reader, '{"a":1,"b":2}', { limits: { cells: 1 } });
    expect(doc.blocks).toHaveLength(1);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('reads dangerous property names without mutating prototypes', async () => {
    const { doc } = await parse(reader, '{"__proto__":{"polluted":"no"},"constructor":"safe"}');
    expect(JSON.stringify(doc)).toContain('record[1].__proto__.polluted: no');
    expect(JSON.stringify(doc)).toContain('record[1].constructor: safe');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('uses the shared depth budget in truncate and throw modes and balances depth on throw', async () => {
    const source = '{"a":{"b":{"c":1}}}';
    const { budget, warnings } = await parse(reader, source, { limits: { blockDepth: 2 } });
    expect(budget.truncated).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');

    let thrownBudget: Budget | undefined;
    const thrown = await parse(reader, source, {
      limits: { blockDepth: 2 },
      onLimit: 'throw',
      captureContext: (ctx) => {
        thrownBudget = ctx.budget;
      },
    }).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(LimitExceededError);
    expect(thrownBudget?.enterDepth('block')).toBe(true);
    expect(thrownBudget?.enterDepth('block')).toBe(true);
    thrownBudget?.exitDepth('block');
    thrownBudget?.exitDepth('block');
  });
});

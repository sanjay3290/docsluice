import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { AbortError, StrictModeError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { XlsxFormulaResolver } from '../../../src/readers/xlsx/formulas.js';

describe('XLSX formula association', () => {
  it('returns formula text verbatim without evaluating it', () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const metadata = { text: '1+1' };

    resolver.register('A1', metadata);

    // The helper only exposes formula text; cell text remains owned by the XLSX cell parser.
    expect(resolver.resolve('A1', metadata, true, true)).toBe('1+1');
    expect(warnings.warnings).toEqual([]);
    expect(resolver.resolve('A1', metadata, true, false)).toBeUndefined();
    expect(resolver.resolve('A1', metadata, true, true)).toBe('1+1');
    expect(resolver.resolve('A1', metadata, true, true)).toBe('1+1');
    expect(budget.cells).toBe(0);
    expect(budget.outputChars).toBe(9);
  });

  it('associates a shared dependent with a master registered later and retains array formulas', () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const dependent = { type: 'shared', sharedIndex: '2', text: '' };
    const master = { type: 'shared', sharedIndex: '2', ref: 'A1:A2', text: 'B1+1' };
    const array = { type: 'array', ref: 'C1:C2', text: 'A1:A2*2' };

    resolver.register('A2', dependent);
    resolver.register('A1', master);
    resolver.register('C1', array);

    expect(resolver.resolve('A2', dependent, true, true)).toBe('B1+1');
    expect(resolver.resolve('A1', master, true, true)).toBe('B1+1');
    expect(resolver.resolve('C1', array, true, true)).toBe('A1:A2*2');
    expect(warnings.warnings).toEqual([]);
    expect(budget.outputChars).toBe('B1+1'.length * 2 + 'A1:A2*2'.length);
  });

  it('keeps a later shared master available when the cell limit is one', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const dependent = { type: 'shared', sharedIndex: '0', text: '' };
    const master = { type: 'shared', sharedIndex: '0', ref: 'A1:A2', text: 'B1+1' };
    const otherMaster = { type: 'shared', sharedIndex: '1', ref: 'A3:A4', text: 'C1+1' };

    resolver.register('A2', dependent);
    resolver.register('A1', master);
    resolver.register('A3', otherMaster);

    expect(resolver.resolve('A1', dependent, true, true)).toBe('B1+1');
    expect(resolver.resolve('A3', otherMaster, true, true)).toBe('C1+1');
    expect(budget.cells).toBe(0);
    expect(warnings.warnings).toEqual([]);
  });

  it('charges only formula text returned for retained cells', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 3 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const master = { type: 'shared', sharedIndex: '1', ref: 'A1:A2', text: '1+1' };

    resolver.register('A1', master);

    expect(resolver.resolve('A1', master, true, false)).toBeUndefined();
    expect(budget.outputChars).toBe(0);
    expect(resolver.resolve('A1', master, true, true)).toBe('1+1');
    expect(warnings.warnings).toEqual([]);
    expect(budget.outputChars).toBe(3);
  });

  it('charges formula output once alongside the builder-charged cached cell text', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 4 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const formula = resolver.resolve('A1', { text: '1+1' }, true, true);
    expect(formula).toBe('1+1');

    const builder = new DocBuilder(
      'xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      budget,
    );
    builder.table([[{ text: '5', raw: 5, formula }]], 0);
    const document = builder.finish();

    expect(document.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: '5', raw: 5, formula: '1+1' }]],
    });
    expect(budget.outputChars).toBe(4);
    expect(document.stats.truncated).toBe(false);
  });

  it('rejects a shared master formula beyond the source text bound', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const master = {
      type: 'shared',
      sharedIndex: '2',
      ref: 'A1:A2',
      text: 'x'.repeat(2_000_001),
    };

    resolver.register('A1', master);

    expect(resolver.resolve('A1', master, true, true)).toBeUndefined();
    expect(
      warnings.warnings.some(
        (warning) => warning.message === 'A worksheet formula exceeded the bounded reader capacity.',
      ),
    ).toBe(true);
    expect(JSON.stringify(warnings.warnings)).not.toContain('x'.repeat(100));
  });

  it('treats exact repeat registration as idempotent', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const master = { type: 'shared', sharedIndex: '3', ref: 'A1:A2', text: 'B1+1' };

    resolver.register('A1', master);
    resolver.register('A1', master);

    expect(resolver.resolve('A1', master, true, true)).toBe('B1+1');
    expect(warnings.warnings).toEqual([]);
  });

  it('rejects malformed shared formula ranges without exposing their text', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const master = { type: 'shared', sharedIndex: '5', ref: 'A1:ZZZZZZ9', text: 'private formula' };

    resolver.register('A1', master);

    expect(resolver.resolve('A1', master, true, true)).toBeUndefined();
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.code).toBe('UNREADABLE_PART');
    expect(warnings.warnings[0]?.message).not.toContain('private formula');
  });

  it('poisons a canonical shared index after an invalid master registration', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const invalid = { type: 'shared', sharedIndex: '7', ref: 'A1:ZZZZZZ9', text: 'secret invalid' };
    const later = { type: 'shared', sharedIndex: '7', ref: 'A1:A2', text: 'later formula' };

    resolver.register('A1', invalid);
    resolver.register('A1', later);

    expect(resolver.resolve('A1', later, true, true)).toBeUndefined();
    expect(warnings.warnings).toHaveLength(1);
    expect(JSON.stringify(warnings.warnings)).not.toContain('secret');
    expect(JSON.stringify(warnings.warnings)).not.toContain('later formula');
  });

  it('requires the shared master cell to be the top-left cell of its declared range', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const misplaced = { type: 'shared', sharedIndex: '8', ref: 'A1:B2', text: 'secret' };

    resolver.register('B1', misplaced);

    expect(resolver.resolve('B1', misplaced, true, true)).toBeUndefined();
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).toBe('A worksheet shared formula could not be associated.');
  });

  it('rejects shared dependents outside the master range', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const master = { type: 'shared', sharedIndex: '9', ref: 'A1:A2', text: 'A1+1' };
    const outside = { type: 'shared', sharedIndex: '9', text: '' };

    resolver.register('A1', master);
    expect(resolver.resolve('A3', outside, true, true)).toBeUndefined();
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).toBe('A worksheet shared formula could not be associated.');
  });

  it('charges formula output cumulatively and truncates formulas that do not fit', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 5 }, { warnings, onLimit: 'truncate' });
    const resolver = new XlsxFormulaResolver(budget, warnings);

    expect(resolver.resolve('A1', { text: '1+1' }, true, true)).toBe('1+1');
    expect(resolver.resolve('A2', { text: '2+2' }, true, true)).toBeUndefined();
    expect(resolver.resolve('A3', { text: '3+3' }, true, true)).toBeUndefined();
    expect(budget.outputChars).toBe(3);
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('throws before charging a formula that would exceed output in throw mode', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 5 }, { warnings, onLimit: 'throw' });
    const resolver = new XlsxFormulaResolver(budget, warnings);

    expect(resolver.resolve('A1', { text: '1+1' }, true, true)).toBe('1+1');
    expect(() => resolver.resolve('A2', { text: '2+2' }, true, true)).toThrow('outputChars');
    expect(budget.outputChars).toBe(3);
  });

  it('propagates aborts and strict output-limit warnings', () => {
    const controller = new AbortController();
    controller.abort();
    const abortWarnings = new WarningSink();
    const abortedBudget = new Budget(DEFAULT_LIMITS, { warnings: abortWarnings, signal: controller.signal });
    const abortedResolver = new XlsxFormulaResolver(abortedBudget, abortWarnings);
    expect(() => abortedResolver.resolve('A1', { text: '1+1' }, true, true)).toThrow(AbortError);

    const strictWarnings = new WarningSink({ strict: true });
    const strictBudget = new Budget(
      { ...DEFAULT_LIMITS, outputChars: 1 },
      { warnings: strictWarnings, onLimit: 'truncate' },
    );
    const strictResolver = new XlsxFormulaResolver(strictBudget, strictWarnings);
    expect(() => strictResolver.resolve('A1', { text: '1+1' }, true, true)).toThrow(StrictModeError);
    expect(strictBudget.outputChars).toBe(0);
  });

  it('bounds distinct shared masters independently of worksheet cell limits', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);

    for (let row = 1; row <= 100_001; row += 1) {
      const address = `A${row}`;
      resolver.register(address, {
        type: 'shared',
        sharedIndex: String(row),
        ref: address,
        text: '1+1',
      });
    }

    expect(
      resolver.resolve(
        'A100001',
        {
          type: 'shared',
          sharedIndex: '100001',
          ref: 'A100001',
          text: '1+1',
        },
        true,
        true,
      ),
    ).toBeUndefined();
    expect(budget.cells).toBe(0);
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.code).toBe('UNREADABLE_PART');
  });

  it('keeps poisoned shared indexes within the master-map cap', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);

    for (let row = 1; row <= 100_001; row += 1) {
      resolver.register(`A${row}`, {
        type: 'shared',
        sharedIndex: String(row),
        ref: 'invalid-range',
        text: 'bad',
      });
    }
    const valid = { type: 'shared', sharedIndex: '100001', ref: 'A100001:A100002', text: '1+1' };
    resolver.register('A100001', valid);

    expect(resolver.resolve('A100001', valid, true, true)).toBeUndefined();
    expect(budget.cells).toBe(0);
    expect(budget.outputChars).toBe(0);
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).toBe('A worksheet shared formula could not be associated.');
  });

  it('caps cumulative master formula text without tripping the cell or output budget', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, cells: 1 }, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings);
    const text = 'x'.repeat(2_000_000);

    for (let column = 1; column <= 11; column += 1) {
      const address = `${String.fromCharCode(64 + column)}1`;
      resolver.register(address, {
        type: 'shared',
        sharedIndex: String(column),
        ref: address,
        text,
      });
    }

    expect(budget.cells).toBe(0);
    expect(budget.outputChars).toBe(0);
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).toBe('A worksheet formula exceeded the bounded reader capacity.');
  });

  it('warns once per sheet for missing cached values even when formulas are disabled', () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const resolver = new XlsxFormulaResolver(budget, warnings, {
      path: 'xl/worksheets/sheet1.xml',
    });
    const first = { text: 'NOW()' };
    const second = { type: 'array', ref: 'A2:A3', text: '1+1' };

    resolver.register('A1', first);
    resolver.register('A2', second);

    expect(resolver.resolve('A1', first, false, false)).toBeUndefined();
    expect(resolver.resolve('A2', second, false, false)).toBeUndefined();
    expect(warnings.warnings).toEqual([
      {
        code: 'UNREADABLE_PART',
        message: 'A worksheet formula cell has no cached value.',
        loc: { path: 'xl/worksheets/sheet1.xml' },
      },
    ]);
    expect(budget.outputChars).toBe(0);
  });

  it('warns once for a malformed shared formula group without including file data', () => {
    const warnings = new WarningSink();
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);
    const firstMaster = { type: 'shared', sharedIndex: '4', ref: 'A1:A2', text: '1+1' };
    const secondMaster = { type: 'shared', sharedIndex: '4', ref: 'B1:B2', text: '2+2' };
    const badDependent = { type: 'shared', sharedIndex: '999999999999999999999', text: '' };

    resolver.register('A1', firstMaster);
    resolver.register('B1', secondMaster);
    resolver.register('C1', badDependent);

    expect(resolver.resolve('C1', badDependent, true, true)).toBeUndefined();
    expect(resolver.resolve('A1', firstMaster, true, true)).toBeUndefined();
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.message).toBe('A worksheet shared formula could not be associated.');
    expect(JSON.stringify(warnings.warnings)).not.toMatch(/1\+1|2\+2|999999/);
  });

  it('propagates missing-cache warnings through strict mode', () => {
    const warnings = new WarningSink({ strict: true });
    const resolver = new XlsxFormulaResolver(new Budget(DEFAULT_LIMITS, { warnings }), warnings);

    expect(() => resolver.resolve('A1', { text: '1+1' }, false, false)).toThrow(
      expect.objectContaining({ code: 'STRICT_WARNING', warningCode: 'UNREADABLE_PART' }),
    );
  });
});

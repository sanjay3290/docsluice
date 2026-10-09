import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbortError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { builtInNumberFormat, formatNumber } from '../../../src/readers/xlsx/numfmt.js';

type ReferenceCase = {
  id: string;
  format_code: string;
  value: string;
  date_system: 1900 | 1904;
  family: string;
  kind: 'text' | 'number';
  libreoffice_display: string;
};

type RoundingEdgeCase = {
  value: string;
  format_code: string;
  display: string;
};

type RenderingEdgeCase = RoundingEdgeCase;

const reference = JSON.parse(
  readFileSync(new URL('./fixtures/numfmt/libreoffice-reference.json', import.meta.url), 'utf8'),
) as { source: { application: string }; cases: ReferenceCase[] };
const roundingEdges = JSON.parse(
  readFileSync(new URL('./fixtures/numfmt/rounding-edgecases.json', import.meta.url), 'utf8'),
) as { source: { application: string }; cases: RoundingEdgeCase[] };
const renderingEdges = JSON.parse(
  readFileSync(new URL('./fixtures/numfmt/rendering-edgecases.json', import.meta.url), 'utf8'),
) as { source: { application: string }; cases: RenderingEdgeCase[] };

// Calc's 1900-system epoch differs from Excel before March 1900. Its export also
// materializes width-dependent `_` spacing, which this helper intentionally skips.
const epochExcludedCases = reference.cases.filter((row) => {
  const hasCalendarFields = row.family === 'date' || row.family.startsWith('date-system-');
  return row.date_system === 1900 && hasCalendarFields && Number(row.value) < 61;
});
const widthPaddingExcludedCases = reference.cases.filter(
  (row) => row.format_code.includes('_') && !epochExcludedCases.includes(row),
);
const excludedIds = new Set([...epochExcludedCases, ...widthPaddingExcludedCases].map((row) => row.id));
const comparableCases = reference.cases.filter((row) => !excludedIds.has(row.id));

describe('XLSX number formats', () => {
  it('matches the authorized LibreOffice rows outside documented epoch and width-padding differences', () => {
    expect(reference.source.application).toContain('LibreOfficeDev 26.8.0.0.alpha0');
    expect(comparableCases).toHaveLength(349);
    for (const row of comparableCases) {
      const input: number | string = row.kind === 'text' ? row.value : Number(row.value);
      const actual = formatNumber(input, row.format_code, row.date_system === 1904);
      expect(actual, `${row.id} ${row.format_code} ${row.value} (${row.date_system})`).toBe(
        row.libreoffice_display,
      );
    }
  });

  it('records each LibreOffice comparison exclusion by its compatibility reason', () => {
    expect(reference.cases).toHaveLength(421);
    expect(epochExcludedCases).toHaveLength(64);
    expect(widthPaddingExcludedCases).toHaveLength(8);
  });

  it.each([
    [0, 'General'],
    [1, '0'],
    [2, '0.00'],
    [3, '#,##0'],
    [4, '#,##0.00'],
    [5, '"$"#,##0_);("$"#,##0)'],
    [6, '"$"#,##0;("$"#,##0)'],
    [7, '"$"#,##0.00;("$"#,##0.00)'],
    [8, '"$"#,##0.00_);("$"#,##0.00)'],
    [9, '0%'],
    [10, '0.00%'],
    [11, '0.00E+00'],
    [12, '# ?/?'],
    [13, '# ??/??'],
    [14, 'mm-dd-yy'],
    [15, 'd-mmm-yy'],
    [16, 'd-mmm'],
    [17, 'mmm-yy'],
    [18, 'h:mm AM/PM'],
    [19, 'h:mm:ss AM/PM'],
    [20, 'h:mm'],
    [21, 'h:mm:ss'],
    [22, 'm/d/yy h:mm'],
    [37, '#,##0 ;(#,##0)'],
    [38, '#,##0 ;[Red](#,##0)'],
    [39, '#,##0.00;(#,##0.00)'],
    [40, '#,##0.00;[Red](#,##0.00)'],
    [41, '_(* #,##0_);_(* (#,##0);_(* "-"_);_(@_)'],
    [42, '_("$"* #,##0_);_("$"* (#,##0);_("$"* "-"_);_(@_)'],
    [43, '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)'],
    [44, '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)'],
    [45, 'mm:ss'],
    [46, '[h]:mm:ss'],
    [47, 'mmss.0'],
    [48, '##0.0E+0'],
    [49, '@'],
  ] as const)('maps built-in format id %i', (id, formatCode) => {
    expect(builtInNumberFormat(id)).toBe(formatCode);
  });

  it.each([23, 26, 27, 35, 36, 50, -1])('uses General for reserved or unknown built-in id %i', (id) => {
    expect(builtInNumberFormat(id)).toBe('General');
  });

  it('uses the Excel fictitious leap day for 1900-system serial 60', () => {
    expect(formatNumber(60, 'yyyy-mm-dd')).toBe('1900-02-29');
  });

  it('uses the Excel 1900 epoch around the Calc pre-March compatibility difference', () => {
    expect(formatNumber(0, 'yyyy-mm-dd')).toBe('1899-12-31');
    expect(formatNumber(1, 'yyyy-mm-dd')).toBe('1900-01-01');
    expect(formatNumber(59, 'yyyy-mm-dd')).toBe('1900-02-28');
    expect(formatNumber(61, 'yyyy-mm-dd')).toBe('1900-03-01');
  });

  it('uses the 1904 epoch without a host Date or timezone conversion', () => {
    expect(formatNumber(0, 'yyyy-mm-dd', true)).toBe('1904-01-01');
    expect(formatNumber(1, 'yyyy-mm-dd', true)).toBe('1904-01-02');
  });

  it('formats text sections and preserves prototype-looking text as ordinary data', () => {
    expect(formatNumber('__proto__', '"prefix "@')).toBe('prefix __proto__');
    expect(formatNumber('Ada', '@ "suffix"')).toBe('Ada suffix');
  });

  it('skips underscore padding instructions while retaining literal spaces', () => {
    expect(formatNumber(123, '0_)')).toBe('123');
    expect(formatNumber(123, '0_x')).toBe('123');
    expect(formatNumber(123, '0" "')).toBe('123 ');
  });

  it('preserves text when a numeric section has no explicit text section', () => {
    expect(formatNumber('Ada', '0.00')).toBe('Ada');
    expect(formatNumber('Ada', '0;[Red](0);"zero"')).toBe('Ada');
    expect(formatNumber('Ada', '0;[Red](0);@')).toBe('Ada');
    expect(formatNumber('Ada', '0;[Red](0);"zero";"text"')).toBe('text');
  });

  it('applies each trailing scaling comma once after the final numeric placeholder', () => {
    expect(formatNumber(1_234_567, '#0,,')).toBe('1');
    expect(formatNumber(1_234_567, '0.0,,')).toBe('1.2');
  });

  it('keeps scientific-format affixes and signs exactly once', () => {
    expect(formatNumber(1234, '"$"0.00E+00')).toBe('$1.23E+03');
    expect(formatNumber(-1234, '"$"0.00E+00')).toBe('-$1.23E+03');
    expect(formatNumber(-1234, '"$"0.00E+00;("$"0.00E+00)" kg"')).toBe('($1.23E+03) kg');
  });

  it('keeps a leading minus when one-section literals contain signs or parentheses', () => {
    expect(formatNumber(-2, '0"-"')).toBe('-2-');
    expect(formatNumber(-2, '(0)')).toBe('-(2)');
    expect(formatNumber(-2, '"pre"0"post"')).toBe('-pre2post');
  });

  it('renders five m tokens as the first letter of the month', () => {
    expect(formatNumber(1, 'mmmmm')).toBe('J');
  });

  it('handles a fixed denominator of ten as a basic fraction format', () => {
    expect(formatNumber(0.2, '# ?/10')).toBe(' 2/10');
    expect(formatNumber(0.2, '# ?/100')).toBe(' 20/100');
  });

  it('matches separate LibreOffice evidence for values adjacent to decimal halves', () => {
    expect(roundingEdges.source.application).toContain('LibreOfficeDev 26.8.0.0.alpha0');
    expect(roundingEdges.cases).toHaveLength(2);
    for (const edge of roundingEdges.cases) {
      expect(formatNumber(Number(edge.value), edge.format_code), edge.value).toBe(edge.display);
    }
  });

  it('matches separate LibreOffice evidence for fixed fractions and affix/sign placement', () => {
    expect(renderingEdges.source.application).toContain('LibreOfficeDev 26.8.0.0.alpha0');
    expect(renderingEdges.cases).toHaveLength(7);
    for (const edge of renderingEdges.cases) {
      expect(formatNumber(Number(edge.value), edge.format_code), edge.format_code).toBe(edge.display);
    }
  });

  it('falls back to General if no conditional section matches and none is unconditional', () => {
    expect(formatNumber(50, '[>=100]"high";[<0]"negative"')).toBe('50');
  });

  it('returns General text for excessive format-code input without scanning it unboundedly', () => {
    expect(formatNumber(123, '0'.repeat(10_000))).toBe('123');
  });

  it('caps numeric precision for hostile format codes', () => {
    expect(formatNumber(1, `0.${'0'.repeat(30)}`)).toBe(`1.${'0'.repeat(20)}`);
  });

  it('ticks the shared budget while scanning untrusted format code', () => {
    const controller = new AbortController();
    const budget = new Budget(DEFAULT_LIMITS, { signal: controller.signal });
    controller.abort();
    expect(() => formatNumber(1, '0.00', false, budget)).toThrow(AbortError);
  });
});

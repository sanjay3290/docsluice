import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { AbortError, LimitExceededError, StrictModeError } from '../../../src/core/errors.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { parseXml } from '../../../src/xml/index.js';
import type { XmlElement } from '../../../src/xml/tree.js';
import { parseChart } from '../../../src/readers/pptx/charts.js';
import { fuzzPptxCharts } from '../../../fuzz/pptx-charts.fuzz.js';

function chart(
  xml: string,
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  onLimit: 'truncate' | 'throw' = 'throw',
  strict = false,
  signal?: AbortSignal,
) {
  const warnings = new WarningSink({ strict });
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings, onLimit, signal });
  xml = withChartPath(xml);
  const root = parseXml(xml, { budget, warnings });
  if (!root) throw new Error('Fixture XML has no root.');
  return { result: parseChart(root, budget), budget, warnings };
}

function withChartPath(xml: string): string {
  if (!xml.startsWith('<c:chartSpace') || xml.includes('<c:chart>')) return xml;
  const openEnd = xml.indexOf('>');
  const closeStart = xml.lastIndexOf('</c:chartSpace>');
  if (openEnd < 0 || closeStart < 0) return xml;
  return `${xml.slice(0, openEnd + 1)}<c:chart><c:plotArea>${xml.slice(openEnd + 1, closeStart)}</c:plotArea></c:chart>${xml.slice(closeStart)}`;
}

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
}

describe('parseChart', () => {
  it.each(['bar', 'line', 'pie'])(
    'reads two cached series from a %s chart with sparse point indexes',
    (kind) => {
      const { result, budget } = chart(fixture(kind));
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        headerRows: 1,
        rows: [
          [{ text: 'Category' }, { text: 'North' }, { text: 'South' }],
          [{ text: 'Jan' }, { text: '2', raw: 2 }, { text: '5', raw: 5 }],
          [{ text: '' }, { text: '' }, { text: '' }],
          [{ text: 'Mar' }, { text: '8', raw: 8 }, { text: '11', raw: 11 }],
        ],
      });
      expect(budget.cells).toBe(12);
      expect(budget.outputChars).toBe(0);
    },
  );

  it('does not allocate from a huge ptCount and aligns valid points by idx', () => {
    const { result } = chart(
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>North</c:v></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="999999999999"/><c:pt idx="2"><c:v>Mar</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:ptCount val="999999999999"/><c:pt idx="0"><c:v>2</c:v></c:pt><c:pt idx="2"><c:v>8</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`,
    );
    expect(result[0]?.rows).toEqual([
      [{ text: 'Category' }, { text: 'North' }],
      [{ text: '' }, { text: '2', raw: 2 }],
      [{ text: '' }, { text: '' }],
      [{ text: 'Mar' }, { text: '8', raw: 8 }],
    ]);
  });

  it('uses cached values and never evaluates or exposes chart formulas', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>Cached series</c:v></c:tx><c:cat><c:strRef><c:f>SECRET_CATEGORY_FORMULA</c:f><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>SECRET_VALUE_FORMULA</c:f><c:numCache><c:pt idx="0"><c:v>42.5</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`;
    const { result } = chart(xml);
    expect(result[0]?.rows).toEqual([
      [{ text: 'Category' }, { text: 'Cached series' }],
      [{ text: 'Q1' }, { text: '42.5', raw: 42.5 }],
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET_');
  });

  it('keeps numeric category cache text and finite raw numbers', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>Numeric categories</c:v></c:tx><c:cat><c:numRef><c:numCache><c:pt idx="0"><c:v>1.50</c:v></c:pt></c:numCache></c:numRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>Infinity</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`;
    expect(chart(xml).result[0]?.rows).toEqual([
      [{ text: 'Category' }, { text: 'Numeric categories' }],
      [{ text: '1.50', raw: 1.5 }, { text: 'Infinity' }],
    ]);
  });

  it('ignores duplicate, negative, and non-integer point indexes without leaking source text', () => {
    const hostile = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:lineChart><c:ser><c:tx><c:v>SECRET_TITLE</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>SECRET_CATEGORY</c:v></c:pt><c:pt idx="0"><c:v>duplicate</c:v></c:pt><c:pt idx="-1"><c:v>negative</c:v></c:pt><c:pt idx="1.5"><c:v>fraction</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>7</c:v></c:pt><c:pt idx="0"><c:v>9</c:v></c:pt><c:pt idx="-1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:lineChart></c:chartSpace>`;
    const { result, warnings } = chart(hostile);
    expect(result[0]?.rows).toEqual([
      [{ text: 'Category' }, { text: 'SECRET_TITLE' }],
      [{ text: 'SECRET_CATEGORY' }, { text: '7', raw: 7 }],
    ]);
    expect(warnings.warnings).toEqual([]);
  });

  it('preflights complete table limits for throw-mode budgets', () => {
    const xml = fixture('bar');
    expect(() => chart(xml, { cells: 5 })).toThrow(LimitExceededError);
    expect(() => chart(xml, { outputChars: 5 })).toThrow(LimitExceededError);
  });

  it('accepts an exact four-cell table and charges each retained cell once', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`;
    const { result, budget } = chart(xml, { cells: 4, outputChars: 11 });
    expect(result[0]?.rows).toEqual([
      [{ text: 'Category' }, { text: 'S' }],
      [{ text: 'A' }, { text: '1', raw: 1 }],
    ]);
    expect(budget.cells).toBe(4);
    expect(budget.outputChars).toBe(0);
  });

  it('reserves parser text locally and lets DocBuilder charge emitted table text once', () => {
    const xml = withChartPath(
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`,
    );
    const warnings = new WarningSink();
    const budget = new Budget(
      { ...DEFAULT_LIMITS, cells: 4, outputChars: 11 },
      { warnings, onLimit: 'truncate' },
    );
    const root = parseXml(xml, { budget, warnings });
    if (!root) throw new Error('Fixture XML has no root.');
    const tables = parseChart(root, budget);
    expect(tables).toHaveLength(1);
    expect(budget.cells).toBe(4);
    expect(budget.outputChars).toBe(0);

    const builder = new DocBuilder(
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      budget,
    );
    for (const table of tables) builder.table(table.rows, table.headerRows);
    const document = builder.finish();
    expect(document.blocks).toHaveLength(1);
    expect(document.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [{ text: 'Category' }, { text: 'S' }],
        [{ text: 'A' }, { text: '1', raw: 1 }],
      ],
      headerRows: 1,
    });
    expect(budget.outputChars).toBe(11);
    expect(document.stats.truncated).toBe(false);
    expect(warnings.warnings).toEqual([]);
  });

  it('returns only complete rectangular rows and marks cell/output truncation', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:tx><c:v>S</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`;
    const byCells = chart(xml, { cells: 3 }, 'truncate');
    expect(byCells.result[0]?.rows).toEqual([[{ text: 'Category' }, { text: 'S' }]]);
    expect(byCells.result[0]?.rows.every((row) => row.length === 2)).toBe(true);
    expect(byCells.budget.truncated).toBe(true);
    expect(byCells.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');

    const byChars = chart(xml, { outputChars: 10 }, 'truncate');
    expect(byChars.result[0]?.rows).toEqual([[{ text: 'Category' }, { text: 'S' }]]);
    expect(byChars.budget.outputChars).toBe(0);
    expect(byChars.budget.truncated).toBe(true);
    expect(byChars.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('accumulates limits across chart types and retains only a complete partial second table', () => {
    const series = `<c:ser><c:tx><c:v>S</c:v></c:tx><c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt></c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`;
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart>${series}</c:barChart><c:lineChart>${series}</c:lineChart></c:plotArea></c:chart></c:chartSpace>`;
    const { result, budget } = chart(xml, { cells: 7 }, 'truncate');
    expect(result).toHaveLength(2);
    expect(result[0]?.rows).toHaveLength(2);
    expect(result[1]?.rows).toEqual([[{ text: 'Category' }, { text: 'S' }]]);
    expect(result.every((table) => table.rows.every((row) => row.length === 2))).toBe(true);
    expect(budget.truncated).toBe(true);

    const byChars = chart(xml, { outputChars: 20 }, 'truncate');
    expect(byChars.result).toHaveLength(2);
    expect(byChars.result[1]?.rows).toHaveLength(1);
    expect(byChars.budget.outputChars).toBe(0);
    expect(byChars.budget.truncated).toBe(true);
  });

  it('propagates aborts and strict warnings from the shared budget', () => {
    const xml = fixture('bar');
    const controller = new AbortController();
    controller.abort();
    expect(() => chart(xml, {}, 'truncate', false, controller.signal)).toThrow(AbortError);
    expect(() => chart(xml, { outputChars: 1 }, 'truncate', true)).toThrow(StrictModeError);
  });

  it('hard-limits aggregate source text even in unused extension content', () => {
    const unused = 'x'.repeat(20_000_001);
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:extLst><c:ext>${unused}</c:ext></c:extLst></c:plotArea></c:chart></c:chartSpace>`;
    expect(() => chart(xml, { outputChars: 21_000_000 })).toThrow('pptxChartChars');
  });

  it('hard-limits an oversized unused attribute before retaining chart output', () => {
    const root: XmlElement = {
      name: 'c:chartSpace',
      localName: 'chartSpace',
      namespaceURI: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
      attrs: new Map([['unused', 'x'.repeat(20_000_001)]]),
      children: [],
    };
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 21_000_000 }, { warnings, onLimit: 'throw' });
    expect(() => parseChart(root, budget)).toThrow('pptxChartChars');
  });

  it('counts source attribute entries against the independent object cap', () => {
    const attrs = new Map<string, string>();
    for (let index = 0; index < 500_000; index += 1) attrs.set(`a${index}`, '');
    const root: XmlElement = {
      name: 'c:chartSpace',
      localName: 'chartSpace',
      namespaceURI: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
      attrs,
      children: [],
    };
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings, onLimit: 'throw' });
    try {
      parseChart(root, budget);
      throw new Error('Expected chart source object cap to be exceeded.');
    } catch (error) {
      expect(error).toBeInstanceOf(LimitExceededError);
      expect((error as LimitExceededError).limit).toBe('pptxObjects');
      expect((error as Error).message).not.toContain('a499999');
    }
  });

  it('truncates a sparse index at the caller cell limit without leaking source text', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:barChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="10"><c:v>SECRET</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:chartSpace>`;
    const { result, budget, warnings } = chart(xml, { cells: 10 }, 'truncate');
    expect(result[0]?.rows).toHaveLength(5);
    expect(
      result[0]?.rows
        .flat()
        .map(({ text }) => text)
        .join(''),
    ).not.toContain('SECRET');
    expect(budget.truncated).toBe(true);
    expect(warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('keeps the fuzz entry point bounded for arbitrary bytes', () => {
    expect(() => fuzzPptxCharts(new Uint8Array([0, 1, 2, 3, 0xff]))).not.toThrow();
    expect(() => fuzzPptxCharts(new TextEncoder().encode(fixture('bar')))).not.toThrow();
  });

  it('handles non-chart roots and unsupported chart kinds as no result', () => {
    expect(chart('<root/>').result).toEqual([]);
    expect(
      chart(
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:scatterChart/></c:chartSpace>',
      ).result,
    ).toEqual([]);
  });

  it('ignores chart-looking elements injected below an extension path', () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:extLst><c:ext><c:barChart><c:ser><c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>99</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart></c:ext></c:extLst></c:plotArea></c:chart></c:chartSpace>`;
    expect(chart(xml).result).toEqual([]);
  });
});

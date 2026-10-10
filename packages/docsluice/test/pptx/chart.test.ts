import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Limits } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { parseChart } from '../../src/readers/pptx/chart.js';

const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function parse(body: string, limits: Partial<Limits> = {}) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  const xml = `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}"><c:chart>${body}</c:chart></c:chartSpace>`;
  return parseChart(new TextEncoder().encode(xml), { budget, warnings });
}

const points = (kind: 'str' | 'num', values: Array<[number, string]>) =>
  `<c:${kind}Cache><c:ptCount val="${values.length}"/>${values.map(([idx, value]) => `<c:pt idx="${idx}"><c:v>${value}</c:v></c:pt>`).join('')}</c:${kind}Cache>`;
const series = (name: string, categories: Array<[number, string]>, values: Array<[number, string]>) =>
  `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>Sheet1!$B$1</c:f>${points('str', [[0, name]])}</c:strRef></c:tx>` +
  `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$9</c:f>${points('str', categories)}</c:strRef></c:cat>` +
  `<c:val><c:numRef><c:f>Sheet1!$B$2:$B$9</c:f>${points('num', values)}</c:numRef></c:val></c:ser>`;
const richTitle = (...paragraphs: string[]) =>
  `<c:title><c:tx><c:rich><a:bodyPr/>${paragraphs.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</c:rich></c:tx><c:overlay val="0"/></c:title>`;
const text = (table: ReturnType<typeof parse>) => table?.rows.map((row) => row.map((cell) => cell.text));

describe('PPTX chart data (PPT-6)', () => {
  it('turns each series into a column and each category into a row', () => {
    const table = parse(
      `${richTitle('Rainfall', 'by quarter')}<c:autoTitleDeleted val="0"/><c:plotArea><c:barChart><c:barDir val="col"/>` +
        series(
          '2025',
          [
            [0, 'Q1'],
            [1, 'Q2'],
          ],
          [
            [0, '12.5'],
            [1, '30'],
          ],
        ) +
        series(
          '2026',
          [
            [0, 'Q1'],
            [1, 'Q2'],
          ],
          [
            [0, '9'],
            [1, '41.25'],
          ],
        ) +
        `</c:barChart><c:catAx>${richTitle('Axis title (not the chart title)')}</c:catAx></c:plotArea>`,
    );
    expect(table?.title).toBe('Rainfall by quarter');
    expect(text(table)).toEqual([
      ['', '2025', '2026'],
      ['Q1', '12.5', '9'],
      ['Q2', '30', '41.25'],
    ]);
  });

  it('reads combo plots, literal names, cached titles, scatter values and the first category level', () => {
    const table = parse(
      `<c:title><c:tx><c:strRef><c:f>Sheet1!$A$1</c:f>${points('str', [[0, 'Cached title']])}</c:strRef></c:tx></c:title>` +
        '<c:plotArea><c:lineChart><c:ser><c:tx><c:v>Literal</c:v></c:tx>' +
        '<c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="2"/>' +
        '<c:lvl><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:lvl>' +
        '<c:lvl><c:pt idx="0"><c:v>2026</c:v></c:pt></c:lvl></c:multiLvlStrCache></c:multiLvlStrRef></c:cat>' +
        `<c:val><c:numLit>${'<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt>'}</c:numLit></c:val></c:ser></c:lineChart>` +
        `<c:scatterChart><c:ser><c:xVal><c:numRef>${points('num', [[1, '0.5']])}</c:numRef></c:xVal>` +
        `<c:yVal><c:numRef>${points('num', [[1, '7']])}</c:numRef></c:yVal><c:bubbleSize><c:numLit><c:pt idx="5"><c:v>99</c:v></c:pt></c:numLit></c:bubbleSize></c:ser></c:scatterChart></c:plotArea>`,
    );
    expect(table?.title).toBe('Cached title');
    expect(text(table)).toEqual([
      ['', 'Literal', 'Series 2'],
      ['Jan', '1', ''],
      ['Feb', '2', '7'],
    ]);
  });

  it('keeps only cached points, so a sparse cache with a huge point count stays small', () => {
    const table = parse(
      `<c:plotArea><c:pieChart><c:ser><c:val><c:numRef><c:numCache><c:ptCount val="999999"/><c:pt idx="999998"><c:v>3</c:v></c:pt><c:pt idx="2"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>duplicate</c:v></c:pt><c:pt idx="x"><c:v>bad index</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:pieChart></c:plotArea>`,
    );
    expect(table?.title).toBeUndefined();
    expect(text(table)).toEqual([
      ['', 'Series 1'],
      ['3', '1'],
      ['999999', '3'],
    ]);
  });

  it('returns nothing without series, and stops at the cell budget', () => {
    expect(parse(`${richTitle('Empty')}<c:plotArea><c:barChart/></c:plotArea>`)).toBeUndefined();
    const many = Array.from({ length: 50 }, (_, index): [number, string] => [index, String(index)]);
    const plot = `<c:plotArea><c:barChart>${series('s', many, many)}</c:barChart></c:plotArea>`;
    expect(parse(plot, { cells: 1 })).toBeUndefined();
    expect(parse(plot, { cells: 10 })?.rows).toHaveLength(5);
  });
});

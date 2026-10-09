import { describe, expect, it } from 'vitest';
import { Budget } from '../../../../src/core/budget.js';
import { AbortError, LimitExceededError } from '../../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../../src/core/limits.js';
import { WarningSink } from '../../../../src/core/warnings.js';
import type { LayoutLine } from '../../../../src/readers/pdf/layout/layout.js';
import { stageTables, type RuleSegment } from '../../../../src/readers/pdf/tables/index.js';

const page = { width: 300, height: 240 } as const;
const makeLine = (text: string, x: number, y: number, sourceIndex: number, width = 20): LayoutLine => ({
  text,
  x,
  y,
  width,
  height: 10,
  fontSize: 10,
  dir: 'ltr',
  sourceIndex,
  sourceIndices: [sourceIndex],
  column: -1,
});

function ruledGrid(): RuleSegment[] {
  const segments: RuleSegment[] = [];
  const xs = [20, 120, 220];
  const ys = [30, 70, 110];
  let sourceIndex = 0;
  for (const y of ys) segments.push({ x1: xs[0]!, y1: y, x2: xs[2]!, y2: y, sourceIndex: sourceIndex++ });
  for (const x of xs) segments.push({ x1: x, y1: ys[0]!, x2: x, y2: ys[2]!, sourceIndex: sourceIndex++ });
  return segments;
}

function linesForRuledGrid(): LayoutLine[] {
  return [
    makeLine('A1', 45, 55, 4),
    makeLine('B1', 145, 55, 1),
    makeLine('A2', 45, 95, 3),
    makeLine('B2', 145, 95, 2),
  ];
}

function makeBudget(
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
  options: { onLimit?: 'throw' | 'truncate'; signal?: AbortSignal } = {},
) {
  return new Budget({ ...DEFAULT_LIMITS, ...overrides }, { ...options, warnings: new WarningSink() });
}

describe('private PDF table staging', () => {
  it('finds a fully ruled 2x2 grid and maps text/source indices to cells', () => {
    const tables = stageTables(page, linesForRuledGrid(), ruledGrid(), makeBudget());
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      detection: 'ruled',
      rows: [
        {
          cells: [
            { text: 'A1', sourceIndices: [4] },
            { text: 'B1', sourceIndices: [1] },
          ],
        },
        {
          cells: [
            { text: 'A2', sourceIndices: [3] },
            { text: 'B2', sourceIndices: [2] },
          ],
        },
      ],
    });
    expect(Number.isFinite(tables[0]!.confidence)).toBe(true);
    expect(tables[0]!.confidence).toBeGreaterThanOrEqual(0);
    expect(tables[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('finds 3x2 aligned unruled cells in stable reading order', () => {
    const lines = [
      makeLine('A1', 20, 40, 0),
      makeLine('B1', 180, 40, 1),
      makeLine('A2', 20, 60, 2),
      makeLine('B2', 180, 60, 3),
      makeLine('A3', 20, 80, 4),
      makeLine('B3', 180, 80, 5),
    ];
    const tables = stageTables(page, lines, [], makeBudget());
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      detection: 'aligned',
      rows: [
        { cells: [{ text: 'A1' }, { text: 'B1' }] },
        { cells: [{ text: 'A2' }, { text: 'B2' }] },
        { cells: [{ text: 'A3' }, { text: 'B3' }] },
      ],
    });
  });

  it('does not mistake ordinary paragraph lines for a table', () => {
    const lines = [
      makeLine('The first paragraph line.', 20, 40, 0, 180),
      makeLine('continues on the next line.', 20, 54, 1, 190),
      makeLine('and ends on the third line.', 20, 68, 2, 175),
    ];
    expect(stageTables(page, lines, [], makeBudget())).toEqual([]);
  });

  it('rejects incomplete ruled grids instead of inferring missing cell borders', () => {
    const segments = ruledGrid().filter((segment) => !(segment.x1 === 120 && segment.y1 === 30));
    expect(stageTables(page, linesForRuledGrid(), segments, makeBudget())).toEqual([]);
  });

  it('assigns text by cell-center and deterministically handles words near boundaries', () => {
    const lines = [
      makeLine('left', 30, 50, 0, 79), // right edge nears the first divider; center stays left
      makeLine('right', 121, 50, 1, 20),
      makeLine('left2', 30, 90, 2, 79),
      makeLine('right2', 121, 90, 3, 20),
    ];
    const result = stageTables(page, lines, ruledGrid(), makeBudget());
    expect(result[0]?.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
      ['left', 'right'],
      ['left2', 'right2'],
    ]);
  });

  it('deduplicates repeated rule segments and text source indices', () => {
    const lines = linesForRuledGrid();
    lines[0] = { ...lines[0]!, sourceIndices: [4, 4, 4] };
    const segments = [...ruledGrid(), ...ruledGrid()];
    expect(stageTables(page, lines, segments, makeBudget())[0]?.rows[0]?.cells[0]?.sourceIndices).toEqual([
      4,
    ]);
  });

  it('keeps separate ruled regions as separate candidates in stable page order', () => {
    const segments = ruledGrid();
    let sourceIndex = 20;
    for (const y of [30, 70, 110])
      segments.push({ x1: 240, y1: y, x2: 280, y2: y, sourceIndex: sourceIndex++ });
    for (const x of [240, 260, 280])
      segments.push({ x1: x, y1: 30, x2: x, y2: 110, sourceIndex: sourceIndex++ });
    const lines = [
      ...linesForRuledGrid(),
      makeLine('C1', 242, 55, 10, 8),
      makeLine('D1', 262, 55, 11, 8),
      makeLine('C2', 242, 95, 12, 8),
      makeLine('D2', 262, 95, 13, 8),
    ];
    const tables = stageTables(page, lines, segments, makeBudget());
    expect(tables.map(({ x }) => x)).toEqual([20, 240]);
    expect(tables.map(({ sourceIndices }) => sourceIndices)).toEqual([
      [1, 2, 3, 4],
      [10, 11, 12, 13],
    ]);
  });

  it('skips malformed, nonfinite, and out-of-bounds geometry safely', () => {
    const segments = [
      ...ruledGrid(),
      { x1: Number.NaN, y1: 5, x2: 200, y2: 5, sourceIndex: 99 },
      { x1: 1e100, y1: 5, x2: 1e100, y2: 100, sourceIndex: 100 },
    ];
    const lines = [...linesForRuledGrid(), makeLine('outside', 1e100, 60, 101)];
    expect(stageTables(page, lines, segments, makeBudget())).toHaveLength(1);
  });

  it('returns deterministic candidates without mutating readonly inputs', () => {
    const lines = linesForRuledGrid();
    const segments = ruledGrid();
    const lineSnapshot = structuredClone(lines);
    const segmentSnapshot = structuredClone(segments);
    const first = stageTables(page, lines, segments, makeBudget());
    const second = stageTables(page, [...lines].reverse(), [...segments].reverse(), makeBudget());
    expect(second).toEqual(first);
    expect(lines).toEqual(lineSnapshot);
    expect(segments).toEqual(segmentSnapshot);
  });

  it('preflights accepted cells/text without charging counters for the caller', () => {
    const budget = makeBudget();
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), budget)).toHaveLength(1);
    expect(budget.cells).toBe(0);
    expect(budget.outputChars).toBe(0);
  });

  it('accepts plans that fit after prior builder charges without charging those plans twice', () => {
    const budget = makeBudget({ cells: 10, outputChars: 100 });
    expect(budget.addCells(6)).toBe(true);
    expect(budget.addOutputChars(10)).toBe(true);

    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), budget)).toHaveLength(1);
    expect(budget.cells).toBe(6);
    expect(budget.outputChars).toBe(10);
  });

  it('observes an over-budget planned cell count and emits no candidate', () => {
    const budget = makeBudget({ cells: 3 });
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), budget)).toEqual([]);
    expect(budget.cells).toBe(4);
    expect(budget.truncated).toBe(true);
  });

  it('propagates configured cell-limit throw and aborts promptly', () => {
    const strictBudget = makeBudget({ cells: 3 }, { onLimit: 'throw' });
    expect(() => stageTables(page, linesForRuledGrid(), ruledGrid(), strictBudget)).toThrow(
      LimitExceededError,
    );
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      stageTables(page, linesForRuledGrid(), ruledGrid(), makeBudget({}, { signal: controller.signal })),
    ).toThrow(AbortError);
  });

  it('honors staged output-character limit without charging emitted output', () => {
    const budget = makeBudget({ outputChars: 3 });
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), budget)).toEqual([]);
    expect(budget.outputChars).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('checks staged text against prior output without adding the prior count twice', () => {
    const budget = makeBudget({ outputChars: 20 });
    expect(budget.addOutputChars(10)).toBe(true);
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), budget)).toEqual([]);
    expect(budget.outputChars).toBe(10);
    expect(budget.truncated).toBe(true);
  });

  it('stops staging when an earlier byte or output limit produced TRUNCATED', () => {
    const byteBudget = makeBudget({ totalUncompressedBytes: 1 });
    expect(byteBudget.addUncompressed(2)).toBe(false);
    expect(byteBudget.canRead).toBe(true);
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), byteBudget)).toEqual([]);
    expect(byteBudget.cells).toBe(0);
    expect(byteBudget.outputChars).toBe(0);

    const outputBudget = makeBudget({ outputChars: 1 });
    expect(outputBudget.addOutputChars(2)).toBe(false);
    expect(outputBudget.canRead).toBe(true);
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), outputBudget)).toEqual([]);
    expect(outputBudget.cells).toBe(0);
  });

  it('allows a usable parent with DEPTH_LIMIT and still falls back from ruled to aligned detection', () => {
    const ruledBudget = makeBudget({ childDepth: 0 });
    expect(ruledBudget.child().canRead).toBe(false);
    expect(ruledBudget.canRead).toBe(true);
    expect(ruledBudget.truncated).toBe(true);
    expect(stageTables(page, linesForRuledGrid(), ruledGrid(), ruledBudget)).toHaveLength(1);

    const fallbackBudget = makeBudget({ childDepth: 0 });
    fallbackBudget.child();
    const incompleteRules = ruledGrid().filter((segment) => !(segment.x1 === 120 && segment.y1 === 30));
    const alignedLines = [
      makeLine('A1', 20, 40, 0),
      makeLine('B1', 180, 40, 1),
      makeLine('A2', 20, 60, 2),
      makeLine('B2', 180, 60, 3),
      makeLine('A3', 20, 80, 4),
      makeLine('B3', 180, 80, 5),
    ];
    expect(stageTables(page, alignedLines, incompleteRules, fallbackBudget)[0]?.detection).toBe('aligned');
  });

  it('rejects oversized input arrays before unbounded work', () => {
    const lines = Array.from({ length: 100_001 }, (_, index) => makeLine('x', 0, index, index));
    expect(stageTables(page, lines, [], makeBudget())).toEqual([]);
  });

  it('bounds complete ruled-cell analysis even when isolated cells do not qualify as tables', () => {
    const segments: RuleSegment[] = [];
    let sourceIndex = 0;
    for (const y of [10, 50]) {
      for (const x of [10, 50]) {
        segments.push(
          { x1: x, y1: y, x2: x + 20, y2: y, sourceIndex: sourceIndex++ },
          { x1: x, y1: y + 20, x2: x + 20, y2: y + 20, sourceIndex: sourceIndex++ },
          { x1: x, y1: y, x2: x, y2: y + 20, sourceIndex: sourceIndex++ },
          { x1: x + 20, y1: y, x2: x + 20, y2: y + 20, sourceIndex: sourceIndex++ },
        );
      }
    }
    const fitting = makeBudget({ cells: 4 });
    expect(stageTables(page, [], segments, fitting)).toEqual([]);
    expect(fitting.cells).toBe(0);
    expect(fitting.truncated).toBe(false);
    const limited = makeBudget({ cells: 3 });
    expect(stageTables(page, [], segments, limited)).toEqual([]);
    expect(limited.truncated).toBe(true);
    expect(() => stageTables(page, [], segments, makeBudget({ cells: 3 }, { onLimit: 'throw' }))).toThrow(
      LimitExceededError,
    );
  });
});

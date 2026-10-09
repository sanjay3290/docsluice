import { describe, expect, it, vi } from 'vitest';
import { AbortError, TimeoutError } from '../../../../src/core/errors.js';
import { Budget } from '../../../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../../../src/core/limits.js';
import { WarningSink } from '../../../../src/core/warnings.js';
import { layoutPage, type LayoutPage, type TextItem } from '../../../../src/readers/pdf/layout/layout.js';

const page = (width = 600, height = 800, rotation: LayoutPage['rotation'] = 0): LayoutPage => ({
  width,
  height,
  rotation,
});
const budget = (outputChars = DEFAULT_LIMITS.outputChars, overrides: Partial<typeof DEFAULT_LIMITS> = {}) =>
  new Budget({ ...DEFAULT_LIMITS, ...overrides, outputChars }, { warnings: new WarningSink() });

function item(
  text: string,
  x: number,
  top: number,
  width: number,
  options: Partial<Pick<TextItem, 'height' | 'fontSize' | 'dir' | 'sourceIndex'>> = {},
): TextItem {
  const height = options.height ?? 10;
  const baseline = 800 - top - height;
  return {
    text,
    transform: [1, 0, 0, 1, x, baseline],
    width,
    height,
    fontSize: options.fontSize ?? 10,
    dir: options.dir ?? 'ltr',
    sourceIndex: options.sourceIndex ?? 0,
  };
}

function pdfJsItem(
  text: string,
  transform: TextItem['transform'],
  width: number,
  height: number,
  sourceIndex: number,
): TextItem {
  return {
    text,
    transform,
    width,
    height,
    fontSize: Math.hypot(transform[0], transform[1]),
    dir: 'ltr',
    sourceIndex,
  };
}

function run(items: TextItem[], p = page(), outlinePresent = false) {
  return layoutPage(items, p, budget(), { outlinePresent });
}

describe('PDF private layout helpers', () => {
  it('joins nearby words into lines and lines into a paragraph', () => {
    const result = run([
      item('Hello', 40, 40, 24, { sourceIndex: 0 }),
      item('world.', 68, 40, 32, { sourceIndex: 1 }),
      item('Next', 40, 53, 20, { sourceIndex: 2 }),
      item('line.', 64, 53, 24, { sourceIndex: 3 }),
    ]);
    expect(result.lines.map(({ text }) => text)).toEqual(['Hello world.', 'Next line.']);
    expect(result.paragraphs.map(({ text }) => text)).toEqual(['Hello world. Next line.']);
  });

  it('keeps widely separated items apart with deterministic spaces', () => {
    const result = run([
      item('left', 10, 10, 20, { sourceIndex: 0 }),
      item('right', 34, 10, 22, { sourceIndex: 1 }),
    ]);
    expect(result.lines[0]?.text).toBe('left right');
  });

  it('preserves explicit edge spaces at zero geometry gap without adding duplicates', () => {
    const result = run([
      item('Hello ', 40, 40, 30, { sourceIndex: 0 }),
      item(' ', 70, 40, 0, { sourceIndex: 1 }),
      item('world', 70, 40, 30, { sourceIndex: 2 }),
    ]);
    expect(result.lines[0]?.text).toBe('Hello world');
    expect(result.lines[0]?.sourceIndices).toEqual([0, 1, 2]);
  });

  it('orders two and three columns column by column', () => {
    const two = run([
      item('L1', 40, 40, 30, { sourceIndex: 0 }),
      item('R1', 330, 40, 30, { sourceIndex: 1 }),
      item('L2', 40, 60, 30, { sourceIndex: 2 }),
      item('R2', 330, 60, 30, { sourceIndex: 3 }),
    ]);
    expect(two.lines.map(({ text }) => text)).toEqual(['L1', 'L2', 'R1', 'R2']);

    const three = run([
      item('A1', 30, 40, 30, { sourceIndex: 0 }),
      item('B1', 220, 40, 30, { sourceIndex: 1 }),
      item('C1', 410, 40, 30, { sourceIndex: 2 }),
      item('A2', 30, 60, 30, { sourceIndex: 3 }),
      item('B2', 220, 60, 30, { sourceIndex: 4 }),
      item('C2', 410, 60, 30, { sourceIndex: 5 }),
    ]);
    expect(three.lines.map(({ text }) => text)).toEqual(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);
  });

  it('does not let PDF.js intercolumn whitespace bridge adjacent columns', () => {
    const two = run(
      [
        pdfJsItem('Left column first line', [12, 0, 0, 12, 48, 675], 106.704, 12, 5),
        pdfJsItem(' ', [12, 0, 0, 12, 154.704, 675], 175.296, 0, 6),
        pdfJsItem('Right column first line', [12, 0, 0, 12, 330, 675], 114.696, 12, 7),
        pdfJsItem('Left column second line', [12, 0, 0, 12, 48, 655], 126.06, 12, 8),
        pdfJsItem(' ', [12, 0, 0, 12, 174.06, 655], 155.94, 0, 9),
        pdfJsItem('Right column second line', [12, 0, 0, 12, 330, 655], 134.052, 12, 10),
      ],
      page(612, 792),
    );
    expect(two.lines.map(({ text }) => text)).toEqual([
      'Left column first line',
      'Left column second line',
      'Right column first line',
      'Right column second line',
    ]);
    expect(two.lines.map(({ column }) => column)).toEqual([0, 0, 1, 1]);

    const three = run(
      [
        pdfJsItem('Column A row one', [11, 0, 0, 11, 48, 670], 90.475, 11, 5),
        pdfJsItem(' ', [11, 0, 0, 11, 138.475, 670], 91.525, 0, 6),
        pdfJsItem('Column B row one', [11, 0, 0, 11, 230, 670], 90.475, 11, 7),
        pdfJsItem(' ', [11, 0, 0, 11, 320.475, 670], 91.525, 0, 8),
        pdfJsItem('Column C row one', [11, 0, 0, 11, 412, 670], 91.08, 11, 9),
        pdfJsItem('Column A row two', [11, 0, 0, 11, 48, 650], 89.243, 11, 10),
        pdfJsItem(' ', [11, 0, 0, 11, 137.243, 650], 92.757, 0, 11),
        pdfJsItem('Column B row two', [11, 0, 0, 11, 230, 650], 89.243, 11, 12),
        pdfJsItem(' ', [11, 0, 0, 11, 319.243, 650], 92.757, 0, 13),
        pdfJsItem('Column C row two', [11, 0, 0, 11, 412, 650], 89.848, 11, 14),
      ],
      page(612, 792),
    );
    expect(three.lines.map(({ text }) => text)).toEqual([
      'Column A row one',
      'Column A row two',
      'Column B row one',
      'Column B row two',
      'Column C row one',
      'Column C row two',
    ]);
    expect(three.lines.map(({ column }) => column)).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('orders 90-degree rotated lines in their displayed right-to-left columns', () => {
    const result = run(
      [
        pdfJsItem('Rotated page source geometry', [14, 0, 0, 14, 48, 710], 192.206, 14, 3),
        pdfJsItem('Rotation content line', [12, 0, 0, 12, 48, 680], 109.392, 12, 5),
      ],
      page(612, 792, 90),
    );
    expect(result.page).toEqual({ width: 792, height: 612 });
    expect(result.lines.map(({ text }) => text)).toEqual([
      'Rotated page source geometry',
      'Rotation content line',
    ]);
    expect(result.lines.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 710, y: 240.206, width: 14, height: 192.206 },
      { x: 680, y: 157.392, width: 12, height: 109.392 },
    ]);
  });

  it.each([90, 180, 270] as const)(
    'preserves source line order for raw-horizontal text on a %s-degree page',
    (rotation) => {
      const result = run(
        [
          pdfJsItem('First source line', [12, 0, 0, 12, 48, 710], 90, 12, 0),
          pdfJsItem('Second source line', [12, 0, 0, 12, 48, 680], 100, 12, 1),
        ],
        page(612, 792, rotation),
      );
      expect(result.lines.map(({ text }) => text)).toEqual(['First source line', 'Second source line']);
    },
  );

  it('keeps left-to-right display order for upright content pre-rotated on a 90-degree page', () => {
    const result = run(
      [
        pdfJsItem('Pre-rotated left column', [0, 12, -12, 0, 100, 100], 80, 12, 0),
        pdfJsItem('Pre-rotated right column', [0, 12, -12, 0, 100, 400], 80, 12, 1),
      ],
      page(612, 792, 90),
    );
    expect(result.lines.map(({ text }) => text)).toEqual([
      'Pre-rotated left column',
      'Pre-rotated right column',
    ]);
    expect(result.lines.map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual([
      { x: 100, y: 100, width: 80, height: 12 },
      { x: 400, y: 100, width: 80, height: 12 },
    ]);
  });

  it('keeps source order when the final horizontal display text is upside down', () => {
    const result = run(
      [
        pdfJsItem('First source column', [0, -12, 12, 0, 100, 600], 80, 12, 0),
        pdfJsItem('Second source column', [0, -12, 12, 0, 100, 300], 80, 12, 1),
      ],
      page(612, 792, 90),
    );
    expect(result.lines.map(({ text }) => text)).toEqual(['First source column', 'Second source column']);
  });

  it('keeps mixed text orientations separate and in source order', () => {
    const result = run(
      [
        pdfJsItem('First mixed item', [12, 0, 0, 12, 100, 600], 100, 12, 0),
        pdfJsItem('Second mixed item', [0, 12, -12, 0, 300, 500], 100, 12, 1),
      ],
      page(612, 792, 90),
    );
    expect(result.lines.map(({ text, sourceIndices }) => ({ text, sourceIndices }))).toEqual([
      { text: 'First mixed item', sourceIndices: [0] },
      { text: 'Second mixed item', sourceIndices: [1] },
    ]);
  });

  it('keeps paragraph grouping rotation-invariant and remaps paragraph line references', () => {
    const items = [
      pdfJsItem('First sentence.', [12, 0, 0, 12, 48, 740], 100, 12, 0),
      pdfJsItem('Continued sentence', [12, 0, 0, 12, 48, 724], 120, 12, 1),
      pdfJsItem('Separate paragraph.', [12, 0, 0, 12, 48, 680], 130, 12, 2),
    ];
    const results = ([0, 90, 180, 270] as const).map((rotation) => run(items, page(612, 792, rotation)));
    const paragraphTexts = results.map((result) => result.paragraphs.map(({ text }) => text));
    expect(paragraphTexts.every((texts) => JSON.stringify(texts) === JSON.stringify(paragraphTexts[0]))).toBe(
      true,
    );
    expect(paragraphTexts[0]).toEqual(['First sentence. Continued sentence', 'Separate paragraph.']);
    for (const result of results) {
      for (const paragraph of result.paragraphs) {
        for (const line of paragraph.lines) expect(result.lines).toContain(line);
      }
    }
  });

  it('scales column gaps with the supplied page units', () => {
    const result = run(
      [
        item('L1', 10, 40, 20, { sourceIndex: 0 }),
        item('R1', 170, 40, 20, { sourceIndex: 1 }),
        item('L2', 10, 60, 20, { sourceIndex: 2 }),
        item('R2', 170, 60, 20, { sourceIndex: 3 }),
      ],
      page(300, 800),
    );
    expect(result.lines.map(({ text }) => text)).toEqual(['L1', 'L2', 'R1', 'R2']);
  });

  it('keeps a full-width title before columns and bottom footnotes last', () => {
    const result = run([
      item('Left', 40, 100, 70, { sourceIndex: 1 }),
      item('Title', 80, 20, 440, { sourceIndex: 0, fontSize: 18 }),
      item('Right', 330, 100, 70, { sourceIndex: 2 }),
      item('Footnote', 40, 760, 120, { sourceIndex: 3, fontSize: 8 }),
    ]);
    expect(result.lines.map(({ text }) => text)).toEqual(['Title', 'Left', 'Right', 'Footnote']);
  });

  it('flushes a column zone before a full-width separator', () => {
    const result = run([
      item('L1', 40, 40, 30, { sourceIndex: 0 }),
      item('R1', 330, 40, 30, { sourceIndex: 1 }),
      item('L2', 40, 60, 30, { sourceIndex: 2 }),
      item('R2', 330, 60, 30, { sourceIndex: 3 }),
      item('Wide', 40, 200, 520, { sourceIndex: 4 }),
      item('After', 40, 230, 80, { sourceIndex: 5 }),
    ]);
    expect(result.lines.map(({ text }) => text)).toEqual(['L1', 'L2', 'R1', 'R2', 'Wide', 'After']);
  });

  it('dehyphenates line-ending lowercase continuations and preserves superscripts', () => {
    const result = run([
      item('inter-', 40, 40, 30, { sourceIndex: 0 }),
      item('national', 40, 55, 45, { sourceIndex: 1 }),
      item('exam-', 40, 70, 26, { sourceIndex: 2 }),
      item('ple continues.', 40, 85, 70, { sourceIndex: 3 }),
      item('x', 120, 85, 4, { height: 5, fontSize: 6, sourceIndex: 4 }),
    ]);
    expect(result.lines.map(({ text }) => text)).toEqual(['inter-', 'national', 'exam-', 'ple continues.x']);
    expect(result.paragraphs.map(({ text }) => text)).toEqual(['international example continues.x']);
    expect(result.lines[3]?.y).toBe(95);
  });

  it('detects large-font headings only without an outline', () => {
    const items = [
      item('Body one.', 40, 40, 50, { sourceIndex: 0, fontSize: 10 }),
      item('Body two.', 40, 55, 50, { sourceIndex: 1, fontSize: 10 }),
      item('Section', 40, 20, 80, { sourceIndex: 2, fontSize: 18 }),
    ];
    expect(run(items).paragraphs[0]).toMatchObject({ text: 'Section', heading: true });
    expect(run(items, page(), true).paragraphs.every(({ heading }) => !heading)).toBe(true);
  });

  it('preserves content stream order for RTL lines', () => {
    const result = run([
      item('ثاني', 20, 40, 30, { dir: 'rtl', sourceIndex: 1 }),
      item('أول', 100, 40, 25, { dir: 'rtl', sourceIndex: 0 }),
    ]);
    expect(result.lines[0]?.text).toBe('أول ثاني');
    expect(result.lines[0]?.sourceIndices).toEqual([0, 1]);
  });

  it.each([0, 90, 180, 270] as const)('normalizes page rotation %s', (rotation) => {
    const rotatedItem: TextItem = {
      text: 'rotated',
      transform: [1, 0, 0, 1, 10, 170],
      width: 30,
      height: 10,
      fontSize: 10,
      dir: 'ltr',
      sourceIndex: 0,
    };
    const result = layoutPage([rotatedItem], page(100, 200, rotation), budget());
    expect(result.lines[0]).toMatchObject({ text: 'rotated' });
    if (rotation === 90 || rotation === 270) expect(result.page).toEqual({ width: 200, height: 100 });
    else expect(result.page).toEqual({ width: 100, height: 200 });
    const expected = {
      0: { x: 10, y: 30, width: 30, height: 10 },
      90: { x: 170, y: 40, width: 10, height: 30 },
      180: { x: 60, y: 180, width: 30, height: 10 },
      270: { x: 20, y: 90, width: 10, height: 30 },
    } as const;
    expect(result.lines[0]).toMatchObject(expected[rotation]);
  });

  it('rounds geometry and breaks ties by source index deterministically', () => {
    const result = run([
      item('B', 40.00049, 20, 10, { sourceIndex: 2 }),
      item('A', 40.0004, 20, 10, { sourceIndex: 1 }),
    ]);
    expect(result.lines[0]?.text).toBe('AB');
    expect(result.lines[0]?.x).toBe(40);
  });

  it('skips invalid geometry, ticks the supplied budget, and returns empty pages safely', () => {
    const invalid = item('bad', Number.NaN, 0, 10);
    const oversized = item('huge', 10, 10, 10, { fontSize: 1_000_000 });
    const outsideBound = item('outside', 10_000_000, 10, 10);
    const malformedTransform = {
      ...item('malformed', 10, 10, 10),
      transform: null,
    } as unknown as TextItem;
    const result = layoutPage(
      [invalid, oversized, outsideBound, malformedTransform, item('ok', 10, 10, 10)],
      page(),
      budget(),
    );
    expect(result.lines.map(({ text }) => text)).toEqual(['ok']);
    expect(layoutPage([], page(0, Number.NaN), budget()).paragraphs).toEqual([]);
  });

  it('does not mutate caller items and observes an already-aborted budget signal', () => {
    const original = item('safe', 10, 10, 20);
    const transform = [...original.transform];
    layoutPage([original], page(), budget());
    expect(original.transform).toEqual(transform);

    const controller = new AbortController();
    controller.abort();
    const abortedBudget = new Budget(DEFAULT_LIMITS, {
      warnings: new WarningSink(),
      signal: controller.signal,
    });
    expect(() => layoutPage([original], page(), abortedBudget)).toThrow();
  });

  it('splits paragraphs on large vertical gaps and major indentation changes', () => {
    const result = run([
      item('First paragraph,', 40, 40, 90, { sourceIndex: 0 }),
      item('Still first.', 40, 55, 60, { sourceIndex: 1 }),
      item('Indented start.', 80, 90, 90, { sourceIndex: 2 }),
      item('Far below.', 40, 150, 70, { sourceIndex: 3 }),
    ]);
    expect(result.paragraphs.map(({ text }) => text)).toEqual([
      'First paragraph, Still first.',
      'Indented start.',
      'Far below.',
    ]);
  });

  it('uses sentence punctuation with line spacing to split a paragraph', () => {
    const result = run([
      item('Completed sentence.', 40, 40, 110, { sourceIndex: 0 }),
      item('New paragraph.', 40, 57, 90, { sourceIndex: 1 }),
    ]);
    expect(result.paragraphs.map(({ text }) => text)).toEqual(['Completed sentence.', 'New paragraph.']);
  });

  it('checks staged output text and keeps only a safe prefix at the limit', () => {
    const limited = budget(10);
    expect(limited.addOutputChars(4)).toBe(true);
    const result = layoutPage([item('12345678901234567890', 10, 10, 100)], page(), limited);
    expect(result.paragraphs.map(({ text }) => text)).toEqual(['12345']);
    expect(limited.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(limited.outputChars).toBe(4);

    const unicode = layoutPage([item('abcdef🙂', 10, 10, 50)], page(), budget(8));
    expect(unicode.paragraphs.map(({ text }) => text)).toEqual(['abcdef']);
  });

  it('counts existing output once when staged items still fit', () => {
    const limited = budget(12);
    expect(limited.addOutputChars(4)).toBe(true);
    const result = layoutPage(
      [item('hello', 10, 10, 50), item('x', 80, 10, 10, { sourceIndex: 1 })],
      page(),
      limited,
    );
    expect(result.paragraphs.map(({ text }) => text)).toEqual(['hello x']);
    expect(limited.truncated).toBe(false);
    expect(limited.outputChars).toBe(4);
  });

  it('rejects an unsupported runtime rotation value', () => {
    const invalidPage = { width: 600, height: 800, rotation: 360 } as unknown as LayoutPage;
    expect(layoutPage([item('ignored', 10, 10, 40)], invalidPage, budget()).lines).toEqual([]);
  });

  it('reports unsupported directions so the adapter can warn instead of silently dropping text', () => {
    const vertical = { ...item('vertical', 10, 10, 40), dir: 'ttb' } as unknown as TextItem;
    const result = layoutPage([vertical, item('horizontal', 10, 50, 70)], page(), budget());
    expect(result.lines.map(({ text }) => text)).toEqual(['horizontal']);
    expect(result).toMatchObject({ unsupportedDirectionItems: 1 });
  });

  it('checks elapsed time while scanning a large all-empty input', () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    try {
      const limited = budget(DEFAULT_LIMITS.outputChars, { timeMs: 10 });
      let calls = 0;
      clock.mockImplementation(() => (++calls > 2 ? 11 : 0));
      const empty = Array.from({ length: 5_000 }, () => item('', 10, 10, 40));
      expect(() => layoutPage(empty, page(), limited)).toThrow(TimeoutError);
      expect(calls).toBe(3);
    } finally {
      clock.mockRestore();
    }
  });

  it('observes cancellation that arrives during an all-empty scan', () => {
    const controller = new AbortController();
    const limited = new Budget(DEFAULT_LIMITS, {
      warnings: new WarningSink(),
      signal: controller.signal,
    });
    const tick = limited.tick.bind(limited);
    let calls = 0;
    vi.spyOn(limited, 'tick').mockImplementation(() => {
      if (++calls === 20) controller.abort();
      tick();
    });
    const empty = Array.from({ length: 1_000 }, () => item('', 10, 10, 40));
    expect(() => layoutPage(empty, page(), limited)).toThrow(AbortError);
    expect(calls).toBe(20);
  });

  it('stops on prior resource truncation but still permits a depth-limited parent', () => {
    const uncompressed = budget(DEFAULT_LIMITS.outputChars, { totalUncompressedBytes: 1 });
    expect(uncompressed.addUncompressed(2)).toBe(false);
    expect(layoutPage([item('unread', 10, 10, 30)], page(), uncompressed).lines).toEqual([]);

    const outputLimited = budget(5);
    expect(outputLimited.addOutputChars(6)).toBe(false);
    expect(layoutPage([item('unread', 10, 10, 30)], page(), outputLimited).paragraphs).toEqual([]);

    const parent = budget(DEFAULT_LIMITS.outputChars, { childDepth: 0 });
    const child = parent.child();
    expect(child.canRead).toBe(false);
    expect(layoutPage([item('child', 10, 10, 30)], page(), child).lines).toEqual([]);
    expect(parent.canRead).toBe(true);
    expect(parent.warnings.warnings.map(({ code }) => code)).toEqual(['DEPTH_LIMIT']);
    expect(layoutPage([item('parent', 10, 10, 30)], page(), parent).paragraphs[0]?.text).toBe('parent');
  });

  it('ticks before checking prior truncation so abort remains observable', () => {
    const controller = new AbortController();
    const stopped = new Budget(
      { ...DEFAULT_LIMITS, outputChars: 1 },
      {
        warnings: new WarningSink(),
        signal: controller.signal,
      },
    );
    expect(stopped.addOutputChars(2)).toBe(false);
    controller.abort();
    expect(() => layoutPage([item('text', 10, 10, 30)], page(), stopped)).toThrow(AbortError);
  });
});

import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { layoutPage } from '../../src/readers/pdf/layout/index.js';
import type { LayoutItem } from '../../src/readers/pdf/layout/index.js';

const budget = () => new Budget(DEFAULT_LIMITS);
/** Glyphs are half the font size wide. */
const item = (
  text: string,
  x: number,
  y: number,
  size = 10,
  extra: Partial<LayoutItem> = {},
): LayoutItem => ({
  text,
  x,
  y,
  width: text.length * size * 0.5,
  height: size,
  dirX: 1,
  dirY: 0,
  rtl: false,
  ...extra,
});
const texts = (items: LayoutItem[], headings = false) =>
  layoutPage(items, { headings }, budget()).map((paragraph) =>
    paragraph.parts.map((part) => part.text).join(''),
  );
/** Lines of a column from top to bottom with 12 pt leading. */
const column = (lines: string[], x: number, top = 700, size = 10) =>
  lines.map((text, index) => item(text, x, top - index * 12, size));
/** Interleave columns row by row, the worst content-stream order for reading. */
const interleave = (...columns: LayoutItem[][]) => {
  const result: LayoutItem[] = [];
  for (let row = 0; row < Math.max(...columns.map((c) => c.length)); row++)
    for (const c of columns) if (c[row]) result.push(c[row]!);
  return result;
};
const left = ['Left column one has words', 'left column two has words', 'left column three ends.'];
const right = ['Right column one has words', 'right column two has words', 'right column three ends.'];
const leftText = 'Left column one has words left column two has words left column three ends.';
const rightText = 'Right column one has words right column two has words right column three ends.';

describe('PDF layout', () => {
  it('joins the lines of a single column and splits paragraphs at a gap', () => {
    const items = [
      ...column(['First line of text', 'second line of text.'], 72),
      ...column(['Next paragraph.'], 72, 660),
    ];
    expect(texts(items)).toEqual(['First line of text second line of text.', 'Next paragraph.']);
  });

  it('reads two columns column by column whatever the content-stream order', () => {
    expect(texts(interleave(column(left, 72), column(right, 320)))).toEqual([leftText, rightText]);
    expect(texts([...column(right, 320), ...column(left, 72)])).toEqual([leftText, rightText]);
  });

  it('reads three columns left to right', () => {
    const one = ['Column one first line', 'column one second line'];
    const two = ['Column two first line', 'column two second line'];
    const three = ['Column three first line', 'column three second line'];
    expect(texts(interleave(column(one, 40), column(two, 230), column(three, 420)))).toEqual([
      'Column one first line column one second line',
      'Column two first line column two second line',
      'Column three first line column three second line',
    ]);
  });

  it('reads a full-width title before the columns and a footnote after them', () => {
    const items = [
      item('A full-width title that spans both columns of the page', 72, 740, 16),
      ...interleave(column(left, 72), column(right, 320)),
      item('1 A footnote at the bottom of the page that spans the full width of the text', 72, 80, 8),
    ];
    expect(texts(items)).toEqual([
      'A full-width title that spans both columns of the page',
      leftText,
      rightText,
      '1 A footnote at the bottom of the page that spans the full width of the text',
    ]);
  });

  it('keeps a centred heading between two-column sections in place', () => {
    const items = [
      ...interleave(column(left, 72), column(right, 320)),
      item('Section Two', 250, 640, 14),
      ...interleave(
        column(['Lower left text line one', 'lower left text line two'], 72, 610),
        column(['Lower right text line one', 'lower right text line two'], 320, 610),
      ),
    ];
    expect(texts(items)).toEqual([
      leftText,
      rightText,
      'Section Two',
      'Lower left text line one lower left text line two',
      'Lower right text line one lower right text line two',
    ]);
  });

  it('continues a paragraph into the next column', () => {
    const items = interleave(
      column(['A paragraph that starts in the', 'left column and keeps going', 'on and on until the'], 72),
      column(['bottom, where it ends.', 'A new paragraph starts here', 'and fills the right column.'], 320),
    );
    expect(texts(items)).toEqual([
      'A paragraph that starts in the left column and keeps going on and on until the bottom, where it ends. A new paragraph starts here and fills the right column.',
    ]);
    const ended = interleave(
      column(['A paragraph that starts in the', 'left column and keeps going', 'until it stops here.'], 72),
      column(['and a lowercase start here', 'is still a new paragraph', 'after a sentence end.'], 320),
    );
    expect(texts(ended)).toHaveLength(2);
  });

  it('removes a line-end hyphen only before a lowercase word', () => {
    expect(texts(column(['The infor-', 'mation is here.'], 72))).toEqual(['The information is here.']);
    expect(texts(column(['A well-', 'Known name.'], 72))).toEqual(['A well- Known name.']);
    expect(texts(column(['Pages 10-', '12 only.'], 72))).toEqual(['Pages 10- 12 only.']);
  });

  it('keeps superscripts and subscripts on their line without a space', () => {
    const items = [
      item('E = mc', 72, 700),
      item('2', 102, 704, 6),
      item(' and H', 105, 700),
      item('2', 135, 698, 6),
      item('O.', 138, 700),
    ];
    expect(texts(items)).toEqual(['E = mc2 and H2O.']);
  });

  it('inserts a word space at a visible gap or a whitespace item, not at kerning', () => {
    expect(texts([item('Hello', 72, 700), item('world', 100, 700)])).toEqual(['Hello world']);
    expect(texts([item('Hel', 72, 700), item('lo', 87.5, 700)])).toEqual(['Hello']);
    expect(texts([item('Hello', 72, 700), item(' ', 97, 700), item('world', 98, 700)])).toEqual([
      'Hello world',
    ]);
  });

  it('reads a page whose text runs up (rotated 90 degrees) like an upright page', () => {
    // Text direction (0, 1): lines stack to the right as the page is read.
    const rotated = [
      item('First rotated line', 100, 72, 10, { dirX: 0, dirY: 1 }),
      item('second rotated line.', 112, 72, 10, { dirX: 0, dirY: 1 }),
    ];
    expect(texts(rotated)).toEqual(['First rotated line second rotated line.']);
    const upsideDown = [
      item('First flipped line', 500, 700, 10, { dirX: -1, dirY: 0 }),
      item('second flipped line.', 500, 712, 10, { dirX: -1, dirY: 0 }),
    ];
    expect(texts(upsideDown)).toEqual(['First flipped line second flipped line.']);
  });

  it('puts text in another direction after the main text', () => {
    const items = [item('Sidebar', 20, 300, 10, { dirX: 0, dirY: 1 }), ...column(['Main text.'], 72)];
    expect(texts(items)).toEqual(['Main text.', 'Sidebar']);
    const skewed = [item('Stamp', 300, 300, 10, { dirX: 1, dirY: 1 }), ...column(['Main text.'], 72)];
    expect(texts(skewed)).toEqual(['Main text.', 'Stamp']);
  });

  it('keeps right-to-left items in content-stream order', () => {
    const items = [item('שלום', 200, 700, 10, { rtl: true }), item('עולם', 150, 700, 10, { rtl: true })];
    expect(texts(items)).toEqual(['שלום עולם']);
  });

  it('starts a paragraph at a size change, a bullet, or an indent after a sentence end', () => {
    expect(texts([item('Big', 72, 700, 20), item('small text', 72, 680)])).toEqual(['Big', 'small text']);
    expect(texts(column(['• one', '• two'], 72))).toEqual(['• one', '• two']);
    expect(texts(column(['\uf095 one', '\uf0b7 two'], 72))).toEqual(['\uf095 one', '\uf0b7 two']);
    const indented = [
      item('This sentence ends here.', 72, 700),
      item('Indented start of next', 90, 688),
      item('paragraph continues.', 72, 676),
    ];
    expect(texts(indented)).toEqual([
      'This sentence ends here.',
      'Indented start of next paragraph continues.',
    ]);
  });

  it('marks headings by font size only when asked', () => {
    const items = [
      item('Title', 72, 740, 24),
      item('Section', 72, 710, 16),
      ...column(['Body text line one', 'body text line two'], 72, 690),
    ];
    const paragraphs = layoutPage(items, { headings: true }, budget());
    expect(paragraphs.map((p) => p.heading)).toEqual([1, 2, undefined]);
    expect(layoutPage(items, { headings: false }, budget()).map((p) => p.heading)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('does not read a key-value list as two columns', () => {
    const rows = ['Name:', 'Date:', 'Place:'].flatMap((key, index) => [
      item(key, 72, 700 - index * 12),
      item(`Value ${index}`, 300, 700 - index * 12),
    ]);
    expect(texts(rows)).toEqual(['Name: Value 0', 'Date: Value 1', 'Place: Value 2']);
  });

  it('gives the same output for the same items and keeps every item', () => {
    const items = interleave(column(left, 72), column(right, 320));
    const first = layoutPage(items, { headings: true }, budget());
    expect(layoutPage(items, { headings: true }, budget())).toEqual(first);
    const used = first.flatMap((p) => p.parts.flatMap((part) => (part.item ? [part.item] : [])));
    expect(new Set(used)).toEqual(new Set(items));
  });

  it('skips items with non-finite or huge coordinates and survives many items', () => {
    const bad = [
      item('NaN', Number.NaN, 700),
      item('Huge', 1e12, 700),
      item('Inf', 72, Infinity),
      item('Good', 72, 700),
    ];
    expect(texts(bad)).toEqual(['Good']);
    const many = Array.from({ length: 20_000 }, (_, index) =>
      item(`w${index}`, 72 + (index % 50) * 10, 700 - Math.floor(index / 50) * 12),
    );
    const started = performance.now();
    expect(layoutPage(many, { headings: true }, budget()).length).toBeGreaterThan(0);
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('stops when the budget aborts', () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = new Budget(DEFAULT_LIMITS, { signal: controller.signal });
    expect(() => layoutPage(column(left, 72), { headings: false }, aborted)).toThrow(/abort/i);
  });
});

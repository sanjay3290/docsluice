import { describe, expect, it, vi } from 'vitest';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { chunk } from '../../src/chunk/index.js';
import { toText } from '../../src/render/text.js';

const doc = (blocks: Block[]): DocsluiceDocument => ({
  format: 'txt',
  mimeType: 'text/plain',
  metadata: {},
  features: {
    hasMacros: false,
    hasExternalLinks: false,
    hasEmbeddedFiles: false,
    isEncrypted: false,
    hasJavaScript: false,
  },
  blocks,
  children: [],
  warnings: [],
  stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
});

const paragraph = (text: string, offset = 0): Block => ({
  kind: 'paragraph',
  text,
  loc: { path: 'source.txt', offset: [offset, offset + text.length] },
});

describe('chunk', () => {
  it('lazily chunks by section and reproduces the rendered text without overlap', () => {
    const document = doc([
      { kind: 'heading', level: 1, text: 'Overview', loc: { offset: [0, 8] } },
      paragraph('First sentence. Second sentence.', 10),
      { kind: 'heading', level: 2, text: 'Details', loc: { offset: [45, 52] } },
      paragraph('More detail.', 54),
    ]);
    const iterator = chunk(document, { maxSize: 18, overlap: 0 });
    expect(iterator).toHaveProperty('next');
    const pieces = Array.from(iterator);
    expect(pieces.every((piece) => piece.text.length <= 18)).toBe(true);
    expect(pieces[0]?.headingPath).toEqual(['Overview']);
    expect(pieces.some((piece) => piece.headingPath.join(' › ') === 'Overview › Details')).toBe(true);
    expect(pieces.map((piece) => piece.text).join('')).toBe(toText(document));
    expect(pieces.map((piece) => piece.index)).toEqual(pieces.map((_, index) => index));
    expect(pieces.every((piece) => piece.text.trim().length === 0 || piece.locations.length > 0)).toBe(true);
  });

  it('respects a custom token counter and validates counter results', () => {
    const counter = vi.fn((text: string) => Math.ceil(text.length / 3));
    const pieces = Array.from(
      chunk(doc([paragraph('abcdefghijkl')]), { maxSize: 2, overlap: 0, countTokens: counter }),
    );
    expect(pieces.every((piece) => counter(piece.text) <= 2)).toBe(true);
    expect(pieces.map((piece) => piece.text).join('')).toBe('abcdefghijkl');
    expect(() => Array.from(chunk(doc([paragraph('x')]), { countTokens: () => Number.NaN }))).toThrow(
      RangeError,
    );
  });

  it('preserves astral code points at custom-counter window boundaries', () => {
    const text = 'aaaaaaa🙂' + 'b'.repeat(20);
    for (const block of [
      paragraph(text),
      { kind: 'table' as const, rows: [[{ text }]], headerRows: 0, loc: {} },
    ]) {
      const counter = (value: string): number => Math.ceil(value.length / 10);
      const pieces = Array.from(chunk(doc([block]), { maxSize: 2, overlap: 0, countTokens: counter }));
      expect(pieces.map((piece) => piece.text).join('')).toBe(text);
      for (const piece of pieces) {
        expect([...piece.text].every((point) => !/^[\uD800-\uDFFF]$/.test(point))).toBe(true);
        expect(counter(piece.text)).toBeLessThanOrEqual(2);
      }
    }
  });

  it('throws when no whole code point fits a custom counter', () => {
    expect(() =>
      Array.from(
        chunk(doc([paragraph('🙂abc')]), {
          maxSize: 1,
          overlap: 0,
          countTokens: (text) => text.length,
        }),
      ),
    ).toThrow('A single Unicode code point exceeds maxSize under countTokens.');
  });

  it('bounds counter work before yielding and across a long paragraph', () => {
    const text = 'a'.repeat(20_000);
    let examined = 0;
    let largestProbe = 0;
    const countTokens = (value: string): number => {
      examined += value.length;
      largestProbe = Math.max(largestProbe, value.length);
      return value.length;
    };
    const iterator = chunk(doc([paragraph(text)]), { maxSize: 20, overlap: 0, countTokens });
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(largestProbe).toBeLessThanOrEqual(100);
    if (first.done) throw new Error('Expected the first chunk.');
    const pieces = [first.value, ...iterator];
    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
    expect(examined).toBeLessThan(text.length * 20);
  });

  it('keeps default section chunks within their sheet or slide heading scope', () => {
    for (const role of ['sheet', 'slide'] as const) {
      const document = doc([
        { kind: 'section', role, title: 'One', loc: {}, blocks: [paragraph('one')] },
        { kind: 'section', role, title: 'Two', loc: {}, blocks: [paragraph('two')] },
        { kind: 'section', role, loc: {}, blocks: [paragraph('untitled')] },
        paragraph('outside'),
      ]);
      const pieces = Array.from(chunk(document, { maxSize: 50, overlap: 0, minSize: 40 }));
      expect(pieces.map((piece) => piece.text).join('')).toBe(toText(document));
      for (const [text, expectedPath] of [
        ['one', ['One']],
        ['two', ['Two']],
        ['untitled', []],
        ['outside', []],
      ] as const) {
        expect(pieces.find((piece) => piece.text.includes(text))?.headingPath).toEqual(expectedPath);
      }
      expect(pieces.every((piece) => !(piece.text.includes('one') && piece.text.includes('two')))).toBe(true);
    }
  });

  it('narrows source offsets to each emitted text span', () => {
    const pieces = Array.from(
      chunk(doc([paragraph('abcdefghijkl', 20)]), { strategy: 'size', maxSize: 5, overlap: 0 }),
    );
    let offset = 20;
    for (const piece of pieces) {
      expect(piece.locations[0]?.offset).toEqual([offset, offset + piece.text.length]);
      offset += piece.text.length;
    }
    expect(offset).toBe(32);
  });

  it('keeps table rows intact when they fit, and marks oversized row splits', () => {
    const table: Block = {
      kind: 'table',
      rows: [
        [{ text: 'a' }, { text: 'b' }],
        [{ text: 'c' }, { text: 'd' }],
      ],
      headerRows: 1,
      loc: { path: 'table.csv' },
    };
    const rows = Array.from(chunk(doc([table]), { maxSize: 5, overlap: 0 }));
    expect(rows.map((piece) => piece.text).join('')).toBe('a\tb\nc\td');
    expect(rows.every((piece) => piece.text !== 'a\t' && piece.text !== 'c\t')).toBe(true);

    const longRow: Block = {
      kind: 'table',
      rows: [[{ text: 'abc' }, { text: 'def' }]],
      headerRows: 0,
      loc: {},
    };
    const split = Array.from(chunk(doc([longRow]), { maxSize: 4, overlap: 0 }));
    expect(split.map((piece) => piece.text).join('')).toBe('abc\tdef');
    expect(split.some((piece) => piece.warnings?.some((warning) => warning.code === 'CHUNK_ROW_SPLIT'))).toBe(
      true,
    );
  });

  it('does not read every table row before yielding its first chunk', () => {
    let visitedRows = 0;
    const rows = new Proxy(
      Array.from({ length: 100 }, (_, index) => [{ text: String(index) }]),
      {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) visitedRows++;
          return Reflect.get(target, key, receiver) as object | number | string | undefined;
        },
      },
    );
    const table: Block = { kind: 'table', rows, headerRows: 0, loc: {} };
    const iterator = chunk(doc([table]), { maxSize: 2, overlap: 0 });
    expect(iterator.next().done).toBe(false);
    expect(visitedRows).toBeLessThan(100);
  });

  it('matches toText for nested sections, lists, tables, images, and empty blocks', () => {
    const document = doc([
      { kind: 'heading', level: 1, text: 'Title', loc: {} },
      {
        kind: 'list',
        ordered: true,
        items: [{ text: 'first' }, { text: 'second', items: [{ text: 'nested' }] }],
        loc: {},
      },
      {
        kind: 'table',
        caption: 'caption',
        rows: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]],
        headerRows: 1,
        loc: {},
      },
      { kind: 'image', alt: 'diagram', loc: {} },
      { kind: 'image', loc: {} },
      {
        kind: 'section',
        role: 'page',
        loc: {},
        blocks: [
          { kind: 'paragraph', text: 'Page one', loc: {} },
          {
            kind: 'section',
            role: 'part',
            loc: {},
            blocks: [{ kind: 'paragraph', text: 'Nested', loc: {} }],
          },
        ],
      },
    ]);
    const pieces = Array.from(chunk(document, { strategy: 'size', maxSize: 500, overlap: 0 }));
    expect(pieces.map((piece) => piece.text).join('')).toBe(toText(document));
  });

  it('uses page and slide section boundaries as chunk boundaries', () => {
    const document = doc([
      { kind: 'section', role: 'page', title: 'Page 1', loc: {}, blocks: [paragraph('one')] },
      { kind: 'section', role: 'slide', title: 'Slide 2', loc: {}, blocks: [paragraph('two')] },
    ]);
    const pieces = Array.from(chunk(document, { strategy: 'page', maxSize: 50, overlap: 0 }));
    expect(pieces.map((piece) => piece.text)).toEqual(['one\n\n', 'two']);
    expect(pieces.at(-1)?.headingPath).toEqual(['Slide 2']);
  });

  it('does not carry headings from one slide or sheet into the next', () => {
    const document = doc([
      {
        kind: 'section',
        role: 'slide',
        title: 'One',
        loc: {},
        blocks: [{ kind: 'heading', level: 1, text: 'Sales', loc: {} }, paragraph('first')],
      },
      { kind: 'section', role: 'slide', title: 'Two', loc: {}, blocks: [paragraph('second')] },
    ]);
    const pieces = Array.from(chunk(document, { strategy: 'page', maxSize: 50, overlap: 0 }));
    expect(pieces.at(-1)?.headingPath).toEqual(['Two']);
  });

  it('adds bounded sentence overlap and produces deterministic output', () => {
    const document = doc([paragraph('One. Two. Three. Four. Five.')]);
    const options = { strategy: 'size' as const, maxSize: 12, overlap: 6 };
    const pieces = Array.from(chunk(document, options));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.text.length <= 12)).toBe(true);
    expect(
      pieces.slice(1).some((piece) => piece.text.startsWith('Two.') || piece.text.startsWith('Three.')),
    ).toBe(true);
    const second = pieces[1]!;
    const covered = second.locations.reduce(
      (total, location) => total + (location.offset ? location.offset[1] - location.offset[0] : 0),
      0,
    );
    expect(covered).toBe(second.text.length);
    expect(Array.from(chunk(document, options))).toEqual(pieces);
  });

  it('prefers CJK sentence endings for overlap when a sentence fits', () => {
    const pieces = Array.from(
      chunk(doc([paragraph('甲。乙。丙。丁。')]), { strategy: 'size', maxSize: 4, overlap: 2 }),
    );
    expect(pieces.some((piece) => piece.text.startsWith('乙。') || piece.text.startsWith('丙。'))).toBe(true);
  });

  it('enforces the default nested block depth limit iteratively', () => {
    let nested: Block = paragraph('deep');
    for (let depth = 0; depth < 65; depth++) {
      nested = { kind: 'section', role: 'part', loc: {}, blocks: [nested] };
    }
    expect(() => Array.from(chunk(doc([nested]), { overlap: 0 }))).toThrow(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED', limit: 'blockDepth' }),
    );
  });

  it('rejects invalid options and reports unbreakable oversized characters', () => {
    expect(() => Array.from(chunk(doc([]), { maxSize: 0 }))).toThrow(RangeError);
    expect(() => Array.from(chunk(doc([]), { maxSize: 2, overlap: 2 }))).toThrow(RangeError);
    expect(() => Array.from(chunk(doc([paragraph('🙂')]), { maxSize: 1 }))).toThrow(RangeError);
  });
});

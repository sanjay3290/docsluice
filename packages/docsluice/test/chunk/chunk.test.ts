import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunk } from '../../src/chunk/index.js';
import type { Chunk, ChunkOptions } from '../../src/chunk/index.js';
import { segments } from '../../src/chunk/pieces.js';
import { Budget } from '../../src/core/budget.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { toText } from '../../src/render/text.js';

const corpus = new URL('../../../../corpus/', import.meta.url);

function documentOf(blocks: Block[]): DocsluiceDocument {
  return {
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
  };
}

const words = (text: string) => text.split(/\s+/u).filter(Boolean).length;
const squash = (text: string) => text.replace(/\s+/gu, '');

/** A seeded document generator: headings, paragraphs of sentences, lists, tables and sections. */
function randomDocument(seed: number): DocsluiceDocument {
  let state = seed >>> 0 || 1;
  const random = () => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state / 2 ** 32;
  };
  const pick = (count: number) => Math.floor(random() * count);
  const word = () =>
    ['alpha', 'beta', 'Gamma', 'delta', 'tide', 'marsh', 'X', 'Yuki', '漢字', 'longwordwithoutbreaks'][
      pick(10)
    ]!;
  const sentence = () => {
    const parts = Array.from({ length: 1 + pick(12) }, word);
    parts[0] = parts[0]![0]!.toUpperCase() + parts[0]!.slice(1);
    return `${parts.join(' ')}${['.', '!', '?', '。'][pick(4)]}`;
  };
  const paragraph = () => Array.from({ length: 1 + pick(5) }, sentence).join(pick(5) === 0 ? '\n' : ' ');
  const block = (): Block => {
    switch (pick(5)) {
      case 0:
        return { kind: 'heading', level: (1 + pick(3)) as 1 | 2 | 3, text: sentence().slice(0, -1), loc: {} };
      case 1:
        return {
          kind: 'list',
          ordered: pick(2) === 0,
          items: [{ text: sentence(), items: [{ text: sentence() }] }, { text: paragraph() }],
          loc: {},
        };
      case 2:
        return {
          kind: 'table',
          headerRows: 0,
          rows: Array.from({ length: 1 + pick(6) }, () =>
            Array.from({ length: 1 + pick(4) }, () => ({ text: pick(3) ? word() : sentence() })),
          ),
          loc: {},
        };
      default:
        return { kind: 'paragraph', text: paragraph(), loc: {} };
    }
  };
  const blocks: Block[] = [];
  for (let index = 0; index < 4 + pick(25); index++) {
    if (pick(6) === 0) {
      blocks.push({
        kind: 'section',
        role: 'slide',
        title: `Slide ${index}`,
        blocks: Array.from({ length: 1 + pick(4) }, block),
        loc: { slide: index },
      });
    } else {
      blocks.push(block());
    }
  }
  return documentOf(blocks);
}

function check(doc: DocsluiceDocument, options: ChunkOptions): Chunk[] {
  const chunks = [...chunk(doc, options)];
  const count = options.countTokens ?? ((text: string) => text.length);
  for (const piece of chunks) expect(count(piece.text)).toBeLessThanOrEqual(options.maxSize ?? 2000);
  expect(squash(chunks.map((piece) => piece.text.slice(piece.overlap)).join(''))).toBe(squash(toText(doc)));
  expect(chunks.map((piece) => piece.index)).toEqual(chunks.map((_, index) => index));
  return chunks;
}

describe('chunk()', () => {
  it('keeps every chunk within maxSize and reproduces toText without overlap (property)', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const doc = randomDocument(seed);
      const strategy = (['section', 'page', 'size'] as const)[seed % 3]!;
      const maxSize = 20 + ((seed * 37) % 400);
      const overlap = (seed * 13) % 120;
      check(doc, { strategy, maxSize, overlap });
      check(doc, { strategy, maxSize: 3 + (seed % 40), overlap: seed % 5, countTokens: words });
    }
  });

  it('never splits a table row that fits (property)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const doc = randomDocument(seed);
      const maxSize = 40 + ((seed * 17) % 200);
      const chunks = check(doc, { strategy: 'size', maxSize, overlap: 0 });
      for (const block of doc.blocks.flatMap((item) => (item.kind === 'section' ? item.blocks : [item]))) {
        if (block.kind !== 'table') continue;
        for (const row of block.rows) {
          const text = row.map((cell) => cell.text).join('\t');
          if (text.length <= maxSize) expect(chunks.some((piece) => piece.text.includes(text))).toBe(true);
        }
      }
    }
  });

  it('is deterministic', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const doc = randomDocument(seed);
      expect([...chunk(doc, { maxSize: 120, overlap: 30 })]).toEqual([
        ...chunk(doc, { maxSize: 120, overlap: 30 }),
      ]);
    }
  });

  it('carries the heading path of nested headings ("Chapter 2 › Pricing")', () => {
    const doc = documentOf([
      { kind: 'heading', level: 1, text: 'Chapter 1', loc: {} },
      { kind: 'paragraph', text: 'Intro text.', loc: {} },
      { kind: 'heading', level: 1, text: 'Chapter 2', loc: {} },
      { kind: 'heading', level: 2, text: 'Pricing', loc: {} },
      { kind: 'paragraph', text: 'Prices rise.', loc: {} },
      { kind: 'heading', level: 2, text: 'Terms', loc: {} },
      { kind: 'paragraph', text: 'Net thirty.', loc: {} },
    ]);
    const chunks = [...chunk(doc)];
    expect(chunks.map((piece) => [piece.headingPath.join(' › '), piece.text])).toEqual([
      ['Chapter 1', 'Chapter 1\n\nIntro text.'],
      ['Chapter 2 › Pricing', 'Chapter 2\n\nPricing\n\nPrices rise.'],
      ['Chapter 2 › Terms', 'Terms\n\nNet thirty.'],
    ]);
  });

  it('uses slide titles in the heading path without repeating the title heading, and cuts per page', async () => {
    const doc = await extract(new Uint8Array(readFileSync(new URL('pptx/reading-order.pptx', corpus))));
    const chunks = [...chunk(doc, { strategy: 'page' })];
    expect(chunks.map((piece) => piece.headingPath)).toEqual([
      ['Estuary Monitoring 2026'],
      ['Two columns'],
      ['Groups and tables'],
      ['Process'],
    ]);
    expect(chunks[1]!.locations[0]).toMatchObject({ slide: 2 });
  });

  it('respects a custom countTokens', () => {
    const doc = documentOf([
      { kind: 'paragraph', text: 'One two three. Four five six. Seven eight nine. Ten.', loc: {} },
    ]);
    const chunks = [...chunk(doc, { maxSize: 6, overlap: 0, countTokens: words })];
    expect(chunks.map((piece) => piece.text)).toEqual([
      'One two three. Four five six.',
      'Seven eight nine. Ten.',
    ]);
  });

  it('prefers sentence ends, then words, then hard cuts', () => {
    const doc = documentOf([
      { kind: 'paragraph', text: 'Short one. Another sentence here. Abcdefghijklmnop', loc: {} },
    ]);
    expect([...chunk(doc, { maxSize: 24, overlap: 0 })].map((piece) => piece.text)).toEqual([
      'Short one.',
      'Another sentence here.',
      'Abcdefghijklmnop',
    ]);
    expect([...chunk(doc, { maxSize: 8, overlap: 0 })].map((piece) => piece.text)).toContain('Abcdefgh');
  });

  it('repeats whole sentences as overlap', () => {
    const doc = documentOf([
      { kind: 'paragraph', text: 'First part here. Second part here. Third part here.', loc: {} },
    ]);
    const chunks = [...chunk(doc, { maxSize: 36, overlap: 18 })];
    expect(chunks.map((piece) => [piece.text, piece.overlap])).toEqual([
      ['First part here. Second part here.', 0],
      ['Second part here. Third part here.', 18],
    ]);
  });

  it('splits a table row longer than maxSize at cell boundaries with a warning', () => {
    const doc = documentOf([
      {
        kind: 'table',
        headerRows: 0,
        rows: [[{ text: 'a'.repeat(10) }, { text: 'b'.repeat(10) }, { text: 'c'.repeat(10) }]],
        loc: {},
      },
    ]);
    const chunks = [...chunk(doc, { maxSize: 21, overlap: 0 })];
    expect(chunks.map((piece) => piece.text)).toEqual([
      `${'a'.repeat(10)}\t${'b'.repeat(10)}`,
      'c'.repeat(10),
    ]);
    expect(chunks[0]!.warnings).toEqual(['A table row longer than maxSize was split at cell boundaries.']);
  });

  it('merges sections shorter than minSize', () => {
    const doc = documentOf([
      { kind: 'heading', level: 1, text: 'A', loc: {} },
      { kind: 'paragraph', text: 'Tiny.', loc: {} },
      { kind: 'heading', level: 1, text: 'B', loc: {} },
      { kind: 'paragraph', text: 'Also tiny.', loc: {} },
    ]);
    expect([...chunk(doc)]).toHaveLength(2);
    expect([...chunk(doc, { minSize: 50 })]).toHaveLength(1);
  });

  it('is lazy and rejects bad options', () => {
    const iterator = chunk(randomDocument(5), { maxSize: 30 });
    expect(iterator.next().done).toBe(false);
    expect(() => chunk(documentOf([]), { maxSize: 0 }).next()).toThrow(RangeError);
    expect(() => chunk(documentOf([]), { overlap: -1 }).next()).toThrow(RangeError);
    expect([...chunk(documentOf([]))]).toEqual([]);
  });

  it('chunks real extracted documents within bounds', async () => {
    for (const path of ['docx/headings-outline.docx', 'xlsx/cell-types.xlsx', 'docx/lists-tables.docx']) {
      const doc = await extract(new Uint8Array(readFileSync(new URL(path, corpus))));
      check(doc, { maxSize: 200, overlap: 40 });
    }
  });
});

describe('sentence segments', () => {
  it('ends sentences before a capital or digit, and at CJK marks', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    expect(
      segments('Dr. smith came. He left! 3 more? 東京。大阪！ok', budget).map((part) => part.text),
    ).toEqual([
      'Dr. smith came.',
      'He left!',
      // 東 is not a capital, so "?" does not end a sentence there; CJK marks always do.
      '3 more? 東京。',
      '大阪！',
      'ok',
    ]);
    expect(segments('line one\nline two', budget).map((part) => [part.text, part.strength])).toEqual([
      ['line one', 3],
      ['line two', 2],
    ]);
  });
});

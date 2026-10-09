import { describe, expect, it, vi } from 'vitest';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { assignOffsets, toText } from '../../src/render/text.js';
import { layout } from '../../src/render/layout.js';
import { Budget } from '../../src/core/budget.js';
import { resolveLimits } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { StrictModeError } from '../../src/core/errors.js';

const loc = () => ({});

const documentWith = (blocks: Block[], children: DocsluiceDocument[] = []): DocsluiceDocument => ({
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
  children: children.map((document, index) => ({
    path: `child-${index}.txt`,
    name: `child-${index}.txt`,
    status: 'extracted',
    document,
  })),
  warnings: [],
  stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
});

describe('toText', () => {
  it('renders every block kind with stable plain-text separators', () => {
    const doc = documentWith([
      { kind: 'heading', level: 2, text: 'Heading', loc: loc() },
      { kind: 'paragraph', text: 'Paragraph', loc: loc() },
      {
        kind: 'list',
        ordered: false,
        items: [{ text: 'first' }, { text: 'second', items: [{ text: 'nested' }] }],
        loc: loc(),
      },
      {
        kind: 'table',
        rows: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]],
        headerRows: 1,
        loc: loc(),
        caption: 'caption',
      },
      { kind: 'code', language: 'ts', text: 'const x = 1;', loc: loc() },
      { kind: 'image', alt: 'diagram', loc: loc() },
      { kind: 'image', loc: loc() },
      { kind: 'note', role: 'comment', text: 'inline note', author: 'Ada', loc: loc() },
      { kind: 'header', text: 'Header', loc: loc() },
      { kind: 'footer', text: 'Footer', loc: loc() },
      {
        kind: 'section',
        role: 'page',
        title: 'Ignored title',
        loc: loc(),
        blocks: [
          { kind: 'paragraph', text: 'Page one', loc: loc() },
          {
            kind: 'section',
            role: 'part',
            loc: loc(),
            blocks: [{ kind: 'paragraph', text: 'Nested page', loc: loc() }],
          },
        ],
      },
      { kind: 'section', role: 'page', loc: loc(), blocks: [] },
    ]);

    expect(toText(doc)).toBe(
      [
        'Heading',
        'Paragraph',
        '• first\n• second\n  • nested',
        'caption\na\tb\nc',
        'const x = 1;',
        'diagram',
        '',
        'inline note',
        'Header',
        'Footer',
        'Page one',
        'Nested page',
        '',
      ].join('\n\n'),
    );
    expect(toText(doc)).toBe(toText(doc));
  });

  it('uses explicit list markers and deterministic ordered defaults', () => {
    const doc = documentWith([
      {
        kind: 'list',
        ordered: true,
        loc: loc(),
        items: [{ text: 'one' }, { text: 'custom', marker: 'b)' }],
      },
    ]);
    expect(toText(doc)).toBe('1. one\nb) custom');
  });

  it('includes extracted children only when requested and introduces them by path', () => {
    const child = documentWith([{ kind: 'paragraph', text: 'child text', loc: loc() }]);
    const doc = documentWith([{ kind: 'paragraph', text: 'parent text', loc: loc() }], [child]);
    expect(toText(doc)).toBe('parent text');
    expect(toText(doc, { children: true })).toBe('parent text\n\nchild-0.txt\nchild text');
    expect(toText(documentWith([], [child]), { children: true })).toBe('child-0.txt\nchild text');
  });

  it('does not add a leading separator after an empty section before child output', () => {
    const child = documentWith([{ kind: 'paragraph', text: 'child text', loc: loc() }]);
    const doc = documentWith([{ kind: 'section', role: 'page', blocks: [], loc: loc() }], [child]);
    expect(toText(doc, { children: true })).toBe('child-0.txt\nchild text');
  });

  it('enforces the default child-document depth limit', () => {
    let child = documentWith([{ kind: 'paragraph', text: 'deep', loc: loc() }]);
    for (let depth = 0; depth < 4; depth++) child = documentWith([], [child]);
    expect(() => toText(child, { children: true })).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED', limit: 'childDepth', value: 3 }),
    );
  });

  it('uses a shared layout budget for ticks without charging standalone render limits', () => {
    let child = documentWith([
      { kind: 'table', rows: [[{ text: 'a' }, { text: 'b' }]], headerRows: 1, loc: {} },
    ]);
    for (let depth = 0; depth < 5; depth++) child = documentWith([], [child]);
    const budget = new Budget(resolveLimits());
    Array.from(layout(child, { children: true }, budget));
    expect(budget.outputChars).toBe(0);
    expect(budget.cells).toBe(0);
    expect(budget.depth).toBe(0);
  });

  it('restores child depth if a strict depth warning throws during entry', () => {
    const child = documentWith([]);
    const doc = documentWith([], [child]);
    const warnings = new WarningSink({ strict: ['DEPTH_LIMIT'] });
    const budget = new Budget(resolveLimits({ childDepth: 0 }), { warnings, onLimit: 'throw' });
    expect(() => Array.from(layout(doc, { children: true }, budget, true))).toThrow(StrictModeError);
    expect(budget.depth).toBe(0);
  });

  it('rejects a child-document cycle promptly', () => {
    const doc = documentWith([]);
    doc.children.push({ path: 'cycle.txt', name: 'cycle.txt', status: 'extracted', document: doc });
    const iterator = layout(doc, { children: true });
    expect(() => {
      for (let count = 0; count < 10; count++) iterator.next();
    }).toThrowError(/cycle/i);
  });

  it('balances section depth when a layout iterator is returned at a start event', () => {
    const budget = new Budget(resolveLimits({ blockDepth: 1 }), { onLimit: 'throw' });
    const doc = documentWith([{ kind: 'section', role: 'part', blocks: [], loc: {} }]);
    const iterator = layout(doc, {}, budget, true);
    expect(iterator.next().value).toMatchObject({ type: 'start-section' });
    iterator.return(undefined);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('balances section depth when a layout consumer throws at a start event', () => {
    const budget = new Budget(resolveLimits({ blockDepth: 1 }), { onLimit: 'throw' });
    const doc = documentWith([{ kind: 'section', role: 'part', blocks: [], loc: {} }]);
    expect(() => {
      for (const event of layout(doc, {}, budget, true)) {
        if (event.type === 'start-section') throw new Error('consumer failed');
      }
    }).toThrowError('consumer failed');
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('assigns leaf and container offsets against the default rendered text', () => {
    const first: Block = { kind: 'paragraph', text: 'alpha', loc: {} };
    const empty: Block = { kind: 'section', role: 'page', blocks: [], loc: {} };
    const inner: Block = { kind: 'heading', level: 1, text: 'beta', loc: {} };
    const section: Block = { kind: 'section', role: 'slide', loc: {}, blocks: [inner] };
    const last: Block = { kind: 'note', role: 'comment', text: 'gamma', loc: {} };
    const doc = documentWith([first, empty, section, last]);
    assignOffsets(doc);
    const text = toText(doc);
    expect(text).toBe('alpha\n\n\n\nbeta\n\ngamma');
    expect(first.loc.offset).toEqual([0, 5]);
    expect(empty.loc.offset).toEqual([7, 7]);
    expect(inner.loc.offset).toEqual([9, 13]);
    expect(section.loc.offset).toEqual([9, 13]);
    expect(last.loc.offset).toEqual([15, 20]);
    for (const block of [first, empty, section, inner, last]) {
      const [start, end] = block.loc.offset!;
      if (block.kind === 'section') continue;
      expect(text.slice(start, end)).toBe(
        block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'note' ? block.text : '',
      );
    }
  });

  it('offsets every generated leaf block to exactly its rendered content', () => {
    const blocks: Block[] = [];
    const atoms = ['__proto__', 'constructor', 'toString', 'x', '🙂', 'a\nb'];
    for (let index = 0; index < 48; index++) {
      const text = atoms[(index * 7) % atoms.length]!;
      const leaf: Block =
        index % 9 === 0
          ? { kind: 'heading', level: 3, text, loc: {} }
          : index % 9 === 1
            ? { kind: 'paragraph', text, loc: {} }
            : index % 9 === 2
              ? { kind: 'note', role: 'annotation', text, loc: {} }
              : index % 9 === 3
                ? { kind: 'code', text, loc: {} }
                : index % 9 === 4
                  ? { kind: 'header', text, loc: {} }
                  : index % 9 === 5
                    ? { kind: 'footer', text, loc: {} }
                    : index % 9 === 6
                      ? { kind: 'list', ordered: false, items: [{ text, items: [{ text }] }], loc: {} }
                      : index % 9 === 7
                        ? { kind: 'table', rows: [[{ text }, { text }]], headerRows: 1, loc: {} }
                        : { kind: 'image', alt: text, loc: {} };
      blocks.push(index % 4 === 0 ? { kind: 'section', role: 'page', loc: {}, blocks: [leaf] } : leaf);
    }
    const doc = documentWith(blocks);
    assignOffsets(doc);
    const text = toText(doc);
    const stack = [...doc.blocks];
    while (stack.length > 0) {
      const block = stack.pop()!;
      expect(block.loc.offset).toBeDefined();
      if (block.kind === 'section') {
        const [start, end] = block.loc.offset!;
        expect(text.slice(start, end)).toBe(toText(documentWith([block])));
        stack.push(...block.blocks);
        continue;
      }
      const [start, end] = block.loc.offset!;
      expect(text.slice(start, end)).toBe(toText(documentWith([block])));
    }
    expect(toText(doc)).toBe(text);
  });

  it('throws before returning output that exceeds the default character budget', () => {
    const doc = documentWith([{ kind: 'paragraph', text: 'x'.repeat(20_000_001), loc: {} }]);
    expect(() => toText(doc)).toThrowError(
      expect.objectContaining({
        code: 'LIMIT_EXCEEDED',
        limit: 'outputChars',
        value: 20_000_000,
      }),
    );
  });

  it('enforces the default block-depth limit without recursive traversal', () => {
    let block: Block = { kind: 'paragraph', text: 'deep', loc: {} };
    for (let depth = 0; depth < 65; depth++) {
      block = { kind: 'section', role: 'part', blocks: [block], loc: {} };
    }
    expect(() => toText(documentWith([block]))).toThrowError(
      expect.objectContaining({ code: 'LIMIT_EXCEEDED', limit: 'blockDepth', value: 64 }),
    );
  });

  it('checks elapsed time during default rendering traversal', () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(60_001);
    try {
      expect(() => toText(documentWith([{ kind: 'paragraph', text: 'timed', loc: {} }]))).toThrowError(
        expect.objectContaining({ code: 'TIMEOUT' }),
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { extract } from '../../src/core/extract.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { Budget } from '../../src/core/budget.js';
import { resolveLimits } from '../../src/core/limits.js';
import type { Limits } from '../../src/core/limits.js';
import { DocBuilder } from '../../src/core/builder.js';
import type { Block, ListItem } from '../../src/core/model.js';
import { AbortError } from '../../src/core/errors.js';
import { WarningSink } from '../../src/core/warnings.js';

const createBuilder = (
  limits: Partial<Limits> = {},
  options: ConstructorParameters<typeof DocBuilder>[3] = {},
) => {
  const budget = new Budget(resolveLimits(limits));
  return { budget, builder: new DocBuilder('txt', 'text/plain', budget, options) };
};

describe('DocBuilder', () => {
  it('builds normalized blocks and returns false after output truncation', () => {
    const { budget, builder } = createBuilder({ outputChars: 5 });
    expect(builder.paragraph('hello')).toBe(true);
    expect(builder.paragraph('world')).toBe(false);
    expect(builder.heading(1, 'discarded')).toBe(false);
    const doc = builder.finish();
    expect(doc.blocks).toEqual([{ kind: 'paragraph', text: 'hello', loc: {} }]);
    expect(doc.stats).toMatchObject({ truncated: true, durationMs: 0 });
    expect(budget.warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('normalizes every content string consistently', () => {
    const { builder } = createBuilder({}, { runs: true });
    builder.paragraph(' e\u0301  \r\n\r\n\r\n\t x \0\u0001\u000b ', {}, [
      { text: 'run  \rnext\r\n\r\n\r\n' },
    ]);
    builder.list(false, [{ text: 'item  \n\n\n next' }], {});
    builder.table([[{ text: 'cell  \n\n\n value' }]], 0, {}, 'caption  ');
    builder.code('code  \r\n\r\n\r\n line\0', {}, 'ts');
    builder.note('comment', 'note  ', {}, 'author');
    builder.headerFooter('header', 'header  ', {});
    builder.image({ alt: 'alt  ' }, {});
    const doc = builder.finish();
    expect(doc.blocks).toEqual([
      {
        kind: 'paragraph',
        text: ' é\n\n\t x',
        loc: {},
        // Runs that do not join to the paragraph text become one plain run of it.
        runs: [{ text: ' é\n\n\t x' }],
      },
      { kind: 'list', ordered: false, items: [{ text: 'item\n\n next' }], loc: {} },
      { kind: 'table', rows: [[{ text: 'cell\n\n value' }]], headerRows: 0, caption: 'caption', loc: {} },
      { kind: 'code', text: 'code\n\n line', language: 'ts', loc: {} },
      { kind: 'note', role: 'comment', text: 'note', author: 'author', loc: {} },
      { kind: 'header', text: 'header', loc: {} },
      { kind: 'image', alt: 'alt', loc: {} },
    ]);
  });

  it('keeps the spaces between runs, drops empty runs, and joins runs to the paragraph text', () => {
    const { builder } = createBuilder({}, { runs: true });
    builder.paragraph('Open the guide now.', {}, [
      { text: 'Open ' },
      { text: '', bold: true },
      { text: 'the guide', href: '/g' },
      { text: ' now.  ' },
    ]);
    builder.paragraph('a\nb', {}, [{ text: 'a  ' }, { text: '\nb' }]);
    const [first, second] = builder.finish().blocks;
    expect(first).toMatchObject({
      text: 'Open the guide now.',
      runs: [{ text: 'Open ' }, { text: 'the guide', href: '/g' }, { text: ' now.' }],
    });
    // A line end between runs: normalized apart they would keep 'a  ', so they become one run.
    expect(second).toMatchObject({ text: 'a\nb', runs: [{ text: 'a\nb' }] });
  });

  it('applies transform once to every block, drops nulls, and calls onBlock in top-level order', () => {
    const seen: string[] = [];
    const onBlock = vi.fn((block: Block) => seen.push(block.kind));
    const transform = vi.fn((block: Block): Block | null => {
      seen.push(`transform:${block.kind}`);
      if (block.kind === 'paragraph' && block.text === 'drop') return null;
      if (block.kind === 'paragraph') return { ...block, text: 'redacted' };
      return block;
    });
    const { builder } = createBuilder({}, { transform, onBlock });
    builder.paragraph('first');
    builder.openSection('page', { page: 1 }, 'Part');
    builder.paragraph('drop');
    builder.heading(2, 'inside');
    builder.closeSection();
    builder.paragraph('last');
    const doc = builder.finish();
    expect(doc.blocks.map((block) => block.kind)).toEqual(['paragraph', 'section', 'paragraph']);
    expect(doc.blocks[0]).toMatchObject({ text: 'redacted' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'section', title: 'Part', blocks: [{ kind: 'heading' }] });
    expect(transform.mock.calls.map(([block]) => block.kind)).toEqual([
      'paragraph',
      'paragraph',
      'heading',
      'section',
      'paragraph',
    ]);
    expect(onBlock.mock.calls.map(([block]) => block.kind)).toEqual(['paragraph', 'section', 'paragraph']);
    expect(seen.filter((item) => item.startsWith('transform:'))).toHaveLength(5);
  });

  it('flattens section and list depth at the configured boundary with DEPTH_LIMIT', () => {
    const { builder, budget } = createBuilder({ blockDepth: 2 });
    builder.openSection('part', {});
    builder.openSection('part', {});
    builder.openSection('part', {});
    builder.paragraph('inside');
    builder.closeSection();
    builder.closeSection();
    builder.closeSection();
    builder.list(false, [{ text: 'one', items: [{ text: 'two', items: [{ text: 'three' }] }] }], {});
    const doc = builder.finish();
    expect(doc.blocks).toMatchObject([
      { kind: 'section', blocks: [{ kind: 'section', blocks: [{ kind: 'paragraph', text: 'inside' }] }] },
      { kind: 'list', items: [{ text: 'one', items: [{ text: 'two' }, { text: 'three' }] }] },
    ]);
    expect(budget.warnings.warnings.map(({ code }) => code)).toEqual(['DEPTH_LIMIT']);
    expect(doc.stats.truncated).toBe(false);
  });

  it('counts text inside nested blocks and transformed expansion against outputChars', () => {
    const { builder, budget } = createBuilder(
      { outputChars: 6 },
      {
        transform: (block) => (block.kind === 'section' ? { ...block, title: 'x'.repeat(7) } : block),
      },
    );
    builder.openSection('part', {}, 'P');
    builder.paragraph('x');
    const accepted = builder.closeSection();
    expect(accepted).toBe(false);
    expect(builder.finish().blocks).toEqual([]);
    expect(budget.outputChars).toBe(0);
    expect(budget.truncated).toBe(true);
  });

  it('counts list markers, nested item text, table cells, and captions once', () => {
    const { builder, budget } = createBuilder({ outputChars: 6 });
    expect(builder.list(false, [{ text: 'ab', marker: '•', items: [{ text: 'c' }] }], {})).toBe(true);
    expect(builder.table([[{ text: 'd' }]], 0, {}, 'e')).toBe(true);
    expect(budget.outputChars).toBe(6);
    expect(builder.code('', {})).toBe(true);
    expect(builder.heading(1, 'x')).toBe(false);
    expect(builder.finish().blocks).toHaveLength(3);
  });

  it('preflights output while a section is open and retains accepted partial text', () => {
    const { builder, budget } = createBuilder({ outputChars: 3 });
    builder.openSection('page', {});
    expect(builder.paragraph('ok')).toBe(true);
    expect(builder.paragraph('xx')).toBe(false);
    expect(builder.closeSection()).toBe(false);
    const document = builder.finish();
    expect(document.blocks).toMatchObject([{ kind: 'section', blocks: [{ kind: 'paragraph', text: 'ok' }] }]);
    expect(document.stats.truncated).toBe(true);
    expect(document.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
    expect(budget.outputChars).toBe(2);
  });

  it('preflights section titles and charges transformed section output only once', () => {
    const { builder, budget } = createBuilder(
      { outputChars: 4 },
      { transform: (block) => (block.kind === 'section' ? { ...block, title: 'XX' } : block) },
    );
    builder.openSection('page', {}, 'P');
    expect(builder.paragraph('ok')).toBe(true);
    expect(builder.closeSection()).toBe(true);
    expect(budget.outputChars).toBe(4);
    expect(builder.finish().blocks).toMatchObject([
      { kind: 'section', title: 'XX', blocks: [{ kind: 'paragraph', text: 'ok' }] },
    ]);
  });

  it('unwinds deep open sections after an output preflight stops a reader', () => {
    const depth = 80;
    const { builder, budget } = createBuilder({ blockDepth: 16, outputChars: 3 });
    for (let index = 0; index < depth; index++) builder.openSection('part', {});
    expect(builder.paragraph('ok')).toBe(true);
    expect(builder.paragraph('xx')).toBe(false);
    const document = builder.finish();
    let blocks = document.blocks;
    for (let index = 0; index < 16; index++) {
      expect(blocks[0]?.kind).toBe('section');
      blocks = blocks[0]?.kind === 'section' ? blocks[0].blocks : [];
    }
    expect(blocks).toMatchObject([{ kind: 'paragraph', text: 'ok' }]);
    expect(document.stats.truncated).toBe(true);
    expect(budget.outputChars).toBe(2);
  });

  it('does not double-count paragraph runs that represent the same visible text', () => {
    const { builder } = createBuilder({ outputChars: 1 }, { runs: true });
    expect(builder.paragraph('a', {}, [{ text: 'a', bold: true }])).toBe(true);
    expect(builder.heading(1, 'b')).toBe(false);
  });

  it('does not retain caller-owned locations, metadata, or callback mutations', () => {
    const loc = { path: 'original' };
    const authors = ['A'];
    const custom = [{ name: 'x', value: 'y' }];
    const onBlock = (block: { loc: { path?: string } }) => {
      block.loc.path = 'changed';
    };
    const { builder } = createBuilder({}, { onBlock });
    builder.setMetadata({ authors, custom });
    builder.paragraph('text', loc);
    loc.path = 'later';
    authors[0] = 'B';
    custom[0]!.value = 'changed';
    const doc = builder.finish();
    expect(doc.blocks[0]?.loc).toEqual({ path: 'original' });
    expect(doc.metadata).toEqual({ authors: ['A'], custom: [{ name: 'x', value: 'y' }] });
  });

  it('copies a 640,000-cell table quickly as dense arrays', () => {
    const { builder } = createBuilder();
    const rows = Array.from({ length: 10_000 }, (_, row) =>
      Array.from({ length: 64 }, (__, column) => ({ text: column === 0 ? `r${row}` : '' })),
    );
    const started = performance.now();
    builder.table(rows, 0, {});
    const doc = builder.finish();
    expect(performance.now() - started).toBeLessThan(3_000);
    const table = doc.blocks[0];
    expect(table?.kind === 'table' && table.rows.length).toBe(10_000);
    expect(table?.kind === 'table' && table.rows[9_999]![0]!.text).toBe('r9999');
  });

  it('copies prototype-named metadata keys as own data properties', () => {
    const { builder } = createBuilder();
    const custom = JSON.parse('[{"name":"__proto__","value":"x","__proto__":{"polluted":true}}]') as Array<{
      name: string;
      value: string;
    }>;
    builder.setMetadata({ custom });
    const doc = builder.finish();
    const copied = doc.metadata.custom![0]!;
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(Object.hasOwn(copied, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('removes personal metadata and note authors when metadata is disabled', () => {
    const { builder } = createBuilder(
      {},
      {
        metadata: false,
        transform: (block) => (block.kind === 'note' ? { ...block, author: 'Inserted Author' } : block),
      },
    );
    builder.setMetadata({
      title: 'Title',
      authors: ['Alice'],
      created: '2020-01-01',
      custom: [{ name: 'author', value: 'Alice' }],
    });
    builder.note('comment', 'Text', {}, 'Alice');
    builder.openSection('page', {});
    builder.note('speaker-notes', 'More', {}, 'Bob');
    builder.closeSection();
    builder.addChild({
      path: 'archive/item',
      name: 'item',
      status: 'extracted',
      document: {
        format: 'txt',
        mimeType: 'text/plain',
        metadata: { authors: ['Nested Author'] },
        features: {
          hasMacros: false,
          hasExternalLinks: false,
          hasEmbeddedFiles: false,
          isEncrypted: false,
          hasJavaScript: false,
        },
        blocks: [{ kind: 'note', role: 'comment', text: 'Nested', author: 'Nested Author', loc: {} }],
        children: [],
        warnings: [],
        stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
      },
    });
    const doc = builder.finish();
    expect(doc.metadata).toEqual({ title: 'Title', created: '2020-01-01' });
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('Bob');
    expect(serialized).not.toContain('Inserted Author');
    expect(serialized).not.toContain('Nested Author');
    expect(doc.blocks[0]).toMatchObject({ kind: 'note' });
    expect(doc.blocks[0]).not.toHaveProperty('author');
    expect(doc.blocks[1]).toMatchObject({ kind: 'section', blocks: [{ kind: 'note' }] });
    expect(doc.blocks[1]?.kind === 'section' && doc.blocks[1].blocks[0]).not.toHaveProperty('author');
  });

  it('records features, warnings, and deterministic document stats', () => {
    const build = () => {
      const { builder } = createBuilder();
      builder.setMetadata({ title: 'A' });
      builder.setFeature('hasMacros');
      builder.setNeedsOcr();
      builder.paragraph('Text');
      return builder.finish();
    };
    expect(build()).toEqual(build());
    expect(build()).toMatchObject({
      format: 'txt',
      mimeType: 'text/plain',
      metadata: { title: 'A' },
      features: {
        hasMacros: true,
        hasExternalLinks: false,
        hasEmbeddedFiles: false,
        isEncrypted: false,
        hasJavaScript: false,
      },
      stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: true },
    });
  });

  it('walks a 10,000-level section stack and transform-generated nesting without recursion', () => {
    const { builder } = createBuilder({ blockDepth: 1 });
    for (let i = 0; i < 10_000; i++) builder.openSection('part', {});
    builder.paragraph('safe');
    for (let i = 0; i < 10_000; i++) builder.closeSection();
    const doc = builder.finish();
    expect(doc.blocks).toHaveLength(1);
    expect(JSON.stringify(doc)).toContain('safe');
  });

  it('flattens transform-expanded synthetic lists iteratively', () => {
    let item: ListItem = { text: 'end' };
    for (let depth = 0; depth < 10_000; depth++) item = { text: 'x', items: [item] };
    const { builder, budget } = createBuilder(
      { blockDepth: 4 },
      {
        transform: (block) =>
          block.kind === 'paragraph'
            ? { kind: 'list', ordered: false, items: [item], loc: block.loc }
            : block,
      },
    );
    builder.paragraph('seed');
    const output = builder.finish();
    expect(output.blocks[0]?.kind).toBe('list');
    expect(JSON.stringify(output)).toContain('end');
    expect(budget.warnings.warnings.map(({ code }) => code)).toEqual(['DEPTH_LIMIT']);
  });

  it('removes an empty transform-generated section when its depth exceeds the limit', () => {
    const { builder } = createBuilder(
      { blockDepth: 1 },
      {
        transform: (block) =>
          block.kind === 'paragraph'
            ? {
                kind: 'section',
                role: 'part',
                loc: {},
                blocks: [{ kind: 'section', role: 'part', loc: {}, blocks: [] }],
              }
            : block,
      },
    );
    builder.paragraph('seed');
    expect(builder.finish().blocks).toEqual([{ kind: 'section', role: 'part', loc: {}, blocks: [] }]);
  });

  it('emits the flattened forest when a transformed root section exceeds depth zero', () => {
    const onBlock = vi.fn((block: Block) => block.kind);
    const { builder, budget } = createBuilder(
      { blockDepth: 0 },
      {
        onBlock,
        transform: (block) =>
          block.kind === 'paragraph'
            ? {
                kind: 'section',
                role: 'part',
                loc: {},
                blocks: [{ kind: 'paragraph', text: 'kept', loc: {} }],
              }
            : block,
      },
    );
    expect(builder.paragraph('source')).toBe(true);
    expect(builder.finish().blocks).toEqual([{ kind: 'paragraph', text: 'kept', loc: {} }]);
    expect(onBlock.mock.calls.map(([block]) => block.kind)).toEqual(['paragraph']);
    expect(budget.warnings.warnings.map(({ code }) => code)).toEqual(['DEPTH_LIMIT']);
    expect(budget.outputChars).toBe(4);
  });

  it('balances open-section depth if title normalization aborts', () => {
    const controller = new AbortController();
    const budget = new Budget(resolveLimits({ blockDepth: 1 }), { signal: controller.signal });
    const builder = new DocBuilder('txt', 'text/plain', budget);
    const failure = new AbortError({ cause: 'title tick' });
    const tick = vi.spyOn(budget, 'tick').mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => builder.openSection('page', {}, 'title')).toThrow(failure);
    tick.mockRestore();
    expect(builder.openSection('page', {})).toBe(true);
    expect(builder.closeSection()).toBe(true);
    expect(builder.finish().blocks).toMatchObject([{ kind: 'section' }]);
  });

  it('balances list flattening depth when strict DEPTH_LIMIT warnings throw', () => {
    const listWarnings = new WarningSink({ strict: ['DEPTH_LIMIT'] });
    const listBudget = new Budget(resolveLimits({ blockDepth: 2 }), { warnings: listWarnings });
    const listBuilder = new DocBuilder('txt', 'text/plain', listBudget);
    listBuilder.openSection('page', {});
    expect(() =>
      listBuilder.list(false, [{ text: 'one', items: [{ text: 'two', items: [{ text: 'three' }] }] }]),
    ).toThrow();
    expect(listBudget.enterDepth('block')).toBe(true);
    listBudget.exitDepth('block');
    listBuilder.closeSection();
  });

  it('balances section flattening depth when strict DEPTH_LIMIT warnings throw', () => {
    const sectionWarnings = new WarningSink({ strict: ['DEPTH_LIMIT'] });
    const sectionBudget = new Budget(resolveLimits({ blockDepth: 2 }), { warnings: sectionWarnings });
    const sectionBuilder = new DocBuilder('txt', 'text/plain', sectionBudget, {
      transform: (block) =>
        block.kind === 'paragraph'
          ? {
              kind: 'section',
              role: 'part',
              loc: {},
              blocks: [
                {
                  kind: 'section',
                  role: 'part',
                  loc: {},
                  blocks: [{ kind: 'paragraph', text: 'deep', loc: {} }],
                },
              ],
            }
          : block,
    });
    sectionBuilder.openSection('page', {});
    expect(() => sectionBuilder.paragraph('source')).toThrow();
    expect(sectionBudget.enterDepth('block')).toBe(true);
    sectionBudget.exitDepth('block');
    sectionBuilder.closeSection();
  });

  it('preserves nested child bytes when enabled and omits them when disabled', () => {
    const child = {
      path: 'archive/item',
      name: 'item',
      status: 'extracted' as const,
      bytes: new Uint8Array([1, 2]),
      document: {
        format: 'txt' as const,
        mimeType: 'text/plain',
        metadata: {},
        features: {
          hasMacros: false,
          hasExternalLinks: false,
          hasEmbeddedFiles: false,
          isEncrypted: false,
          hasJavaScript: false,
        },
        blocks: [],
        children: [
          {
            path: 'archive/item/nested',
            name: 'nested',
            status: 'listed' as const,
            bytes: new Uint8Array([3, 4]),
          },
        ],
        warnings: [],
        stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
      },
    };
    const { builder: includeBuilder } = createBuilder({}, { childBytes: true });
    includeBuilder.addChild(child);
    const included = includeBuilder.finish().children[0]!;
    expect(included.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(included.bytes!)).toEqual([1, 2]);
    expect(included.document?.children[0]?.bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(included.document!.children[0]!.bytes!)).toEqual([3, 4]);
    included.bytes![0] = 9;
    expect(child.bytes[0]).toBe(1);

    const { builder: omitBuilder } = createBuilder({}, { childBytes: false });
    omitBuilder.addChild(child);
    const omitted = omitBuilder.finish().children[0]!;
    expect(omitted).not.toHaveProperty('bytes');
    expect(omitted.document?.children[0]).not.toHaveProperty('bytes');
  });

  it('propagates transform and onBlock errors unchanged', () => {
    const transformError = new Error('transform failure');
    const transformBuilder = createBuilder(
      {},
      {
        transform: () => {
          throw transformError;
        },
      },
    ).builder;
    expect(() => transformBuilder.paragraph('text')).toThrow(transformError);

    const callbackError = new Error('callback failure');
    const callbackBuilder = createBuilder(
      {},
      {
        onBlock: () => {
          throw callbackError;
        },
      },
    ).builder;
    expect(() => callbackBuilder.paragraph('text')).toThrow(callbackError);
  });

  it('checks abort while normalizing a large block', () => {
    const controller = new AbortController();
    const budget = new Budget(resolveLimits(), { signal: controller.signal });
    const builder = new DocBuilder('txt', 'text/plain', budget);
    const originalTick = budget.tick.bind(budget);
    let ticks = 0;
    vi.spyOn(budget, 'tick').mockImplementation(() => {
      ticks++;
      if (ticks === 9) controller.abort('stop normalizing');
      originalTick();
    });
    expect(() => builder.paragraph('x'.repeat(10_000))).toThrow(AbortError);
    expect(ticks).toBe(9);
  });
});

describe('runs over the corpus (MOD-3, #204)', () => {
  const corpus = new URL('../../../../corpus/', import.meta.url);
  const files = readdirSync(corpus, { recursive: true })
    .map((name) => String(name).replaceAll('\\', '/'))
    .filter((name) => /^(?:docx|html|markdown|rtf|odt)\/[^/]+\.(?:docx|html|md|rtf|odt)$/.test(name))
    .sort();

  it.each(files)('%s: every paragraph’s runs join to its text', async (name) => {
    const doc = await extract(new Uint8Array(readFileSync(new URL(name, corpus))), {
      filename: name.slice(name.indexOf('/') + 1),
      runs: true,
    });
    const stack = [...doc.blocks];
    while (stack.length > 0) {
      const block = stack.pop()!;
      if (block.kind === 'section') stack.push(...block.blocks);
      if (block.kind === 'paragraph' && block.runs) {
        expect(block.runs.map((run) => run.text).join('')).toBe(block.text);
        expect(block.runs.every((run) => run.text.length > 0)).toBe(true);
      }
    }
  });

  it('keeps the space before a link in Markdown', async () => {
    const doc = await extract(new Uint8Array(readFileSync(new URL('docx/hyperlinks-image.docx', corpus))), {
      runs: true,
    });
    expect(toMarkdown(doc)).toContain('Open [the transect protocol](');
  });
});

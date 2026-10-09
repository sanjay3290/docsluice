import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { markdownReader as reader } from '../../../src/readers/markdown/index.js';
import { fuzzMarkdown } from '../../../fuzz/markdown.fuzz.js';
import { fuzzTxt } from '../../../fuzz/txt.fuzz.js';

async function parse(source: string, runs = false, limits: Record<string, number> = {}, path = '') {
  const bytes = new TextEncoder().encode(source);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings });
  const options = { limits: budget.limits, runs } as ResolvedOptions;
  const out = new DocBuilder('markdown', 'text/markdown', budget, { runs });
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path,
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

describe('Markdown reader', () => {
  it('parses headings, paragraphs, nested lists, code, tables, and blockquotes', async () => {
    const { doc } = await parse(
      [
        '# Title',
        '',
        'A **bold** [link](https://example.test).',
        '',
        '- parent',
        '  - child',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '| A | B |',
        '| --- | --- |',
        '| x | y |',
        '',
        '> quoted',
        '> second line',
        '',
        'Underlined',
        '---',
        '    indented();',
      ].join('\n'),
    );
    expect(doc.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'code',
      'table',
      'paragraph',
      'heading',
      'code',
    ]);
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Title' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'paragraph', text: 'A bold link.' });
    expect(doc.blocks[2]).toMatchObject({
      kind: 'list',
      items: [{ text: 'parent', items: [{ text: 'child' }] }],
    });
    expect(doc.blocks[3]).toMatchObject({ kind: 'code', language: 'js', text: 'const x = 1;' });
    expect(doc.blocks[4]).toMatchObject({
      kind: 'table',
      headerRows: 1,
      rows: [
        [{ text: 'A' }, { text: 'B' }],
        [{ text: 'x' }, { text: 'y' }],
      ],
    });
    expect(doc.blocks[5]).toMatchObject({ kind: 'paragraph', text: 'quoted\nsecond line' });
    expect(doc.blocks[6]).toMatchObject({ kind: 'heading', level: 2, text: 'Underlined' });
    expect(doc.blocks[7]).toMatchObject({ kind: 'code', text: 'indented();' });
  });

  it('keeps link URLs only in runs mode and bounds deeply nested list input', async () => {
    const plain = await parse('[label](https://example.test)');
    expect(plain.doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'label' });
    expect(plain.doc.blocks[0]).not.toHaveProperty('runs');
    const withRuns = await parse('[label](https://example.test)', true);
    expect(withRuns.doc.blocks[0]).toMatchObject({ runs: [{ text: 'label', href: 'https://example.test' }] });
    const nested = await parse(`${'>'.repeat(10_000)} deep`, false, { blockDepth: 8 });
    expect(JSON.stringify(nested.doc)).toContain('deep');
    expect(nested.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });

  it('bounds wide tables by output and cell budgets and strips URLs from cells', async () => {
    const source = '| [label](https://private.example) |\n| --- |\n| x |\n';
    const plain = await parse(source);
    expect(plain.doc.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: 'label' }], [{ text: 'x' }]],
    });
    const { doc } = await parse(source, false, { outputChars: 1, cells: 1 });
    expect(doc.blocks[0]?.kind).toBe('table');
    if (doc.blocks[0]?.kind === 'table') expect(doc.blocks[0].rows[0]?.[0]?.text).toBe('l');
    const wide = `|${'x|'.repeat(120_000)}\n|${'---|'.repeat(120_000)}\n|${'y|'.repeat(120_000)}`;
    const bounded = await parse(wide, false, { cells: 1, outputChars: 1 });
    expect(bounded.doc.blocks[0]?.kind).toBe('table');
    expect(bounded.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('pads ragged table rows only while the shared cell budget permits it', async () => {
    const source = '| A | B |\n| --- | --- |\n| x |\n';
    const normal = await parse(source);
    expect(normal.doc.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [{ text: 'A' }, { text: 'B' }],
        [{ text: 'x' }, { text: '' }],
      ],
    });
    const bounded = await parse(source, false, { cells: 3 });
    expect(bounded.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('scans unmatched inline delimiters within the time budget and carries child paths', async () => {
    for (const malformed of ['['.repeat(20_000), '<'.repeat(20_000), '`' + 'x'.repeat(20_000)]) {
      const { doc } = await parse(malformed, false, { outputChars: 1, timeMs: 500 }, 'archive/note.md');
      expect(doc.blocks[0]).toMatchObject({
        kind: 'paragraph',
        text: malformed[0],
        loc: { path: 'archive/note.md' },
      });
    }
  });

  it('carries ctx.path through headings, lists, code, tables, and quote paragraphs', async () => {
    const { doc } = await parse(
      '# Head\n\n- item\n\n| A |\n| --- |\n| B |\n\n```js\ncode\n```\n\n> quote',
      false,
      {},
      'bundle/notes.md',
    );
    expect(doc.blocks.map((block) => block.loc.path)).toEqual(
      Array(doc.blocks.length).fill('bundle/notes.md'),
    );
  });

  it('handles CommonMark inline escapes, images, nested link targets, autolinks, and closing heading markers', async () => {
    const { doc } = await parse(
      '# Heading ###\n\nEscaped \\*marks\\*, ~~strike~~, ![alt](https://img.example/x), [label](https://host.test/a(b)c "title"), <https://link.test>, and <tag>.\n\n[[nested]] [unfinished](target',
      true,
    );
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Heading' });
    expect(doc.blocks[1]).toMatchObject({
      kind: 'paragraph',
      text: 'Escaped *marks*, strike, alt, label, , and <tag>.',
    });
    if (doc.blocks[1]?.kind === 'paragraph') {
      expect(doc.blocks[1].runs).toContainEqual({ text: 'label', href: 'https://host.test/a(b)c' });
      expect(doc.blocks[1].runs).toContainEqual({ text: 'alt' });
      expect(doc.blocks[1].runs?.some(({ href }) => href === 'https://img.example/x')).toBe(false);
    }
    expect(doc.blocks[2]).toMatchObject({ kind: 'paragraph', text: '[[nested]] [unfinished](target' });
  });

  it('keeps a link after an escaped literal exclamation mark', async () => {
    const { doc } = await parse(String.raw`\![label](https://link.invalid)`, true);
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: '!label' });
    if (doc.blocks[0]?.kind === 'paragraph')
      expect(doc.blocks[0].runs).toContainEqual({ text: 'label', href: 'https://link.invalid' });
  });

  it('accepts ordered list markers, flattens overdeep items, and reports excessive quote nesting', async () => {
    const { doc, warnings } = await parse(
      '3) first\n4. second\n                  5. buried\n\n> > > quoted',
      false,
      { blockDepth: 1 },
    );
    expect(doc.blocks[0]).toMatchObject({
      kind: 'list',
      ordered: true,
      items: [
        { text: 'first', marker: '3)' },
        { text: 'second', marker: '4.' },
        { text: 'buried', marker: '5.' },
      ],
    });
    expect(doc.blocks.some((block) => block.kind === 'paragraph' && block.text === 'quoted')).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });

  it('starts a new top-level list block when the marker type changes', async () => {
    const { doc } = await parse('* unordered one\n* unordered two\n1. ordered one\n2. ordered two');
    expect(doc.blocks).toMatchObject([
      { kind: 'list', ordered: false, items: [{ text: 'unordered one' }, { text: 'unordered two' }] },
      { kind: 'list', ordered: true, items: [{ text: 'ordered one' }, { text: 'ordered two' }] },
    ]);
  });

  it('nests list items under the nearest parent when indentation skips levels', async () => {
    const { doc } = await parse('- a\n      - b\n      - c\n  - d\n - e');
    expect(doc.blocks[0]).toMatchObject({
      kind: 'list',
      items: [{ text: 'a', items: [{ text: 'b' }, { text: 'c' }, { text: 'd' }] }, { text: 'e' }],
    });
  });

  it('caps a thousand nested list levels at blockDepth', async () => {
    const source = Array.from({ length: 1_000 }, (_, level) => `${'  '.repeat(level)}- item`).join('\n');
    const { doc, warnings } = await parse(source, false, { blockDepth: 8 });
    let depth = 0;
    let items = doc.blocks[0]?.kind === 'list' ? doc.blocks[0].items : [];
    while (items.length > 0) {
      depth++;
      items = items.at(-1)?.items ?? [];
    }
    expect(depth).toBe(8);
    expect(warnings.filter(({ code }) => code === 'DEPTH_LIMIT')).toHaveLength(1);
  });

  it('retains nested mixed-list markers when the block model has only one ordered flag', async () => {
    const { doc } = await parse('* parent\n  1. ordered child\n    - nested bullet');
    expect(doc.blocks[0]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [
        {
          text: 'parent',
          marker: '*',
          items: [{ text: 'ordered child', marker: '1.', items: [{ text: 'nested bullet', marker: '-' }] }],
        },
      ],
    });
  });

  it('handles tilde and unclosed code fences, truncating code within the output budget', async () => {
    const normal = await parse('~~~json extra\n{"ok":true}\n~~~\n');
    expect(normal.doc.blocks[0]).toMatchObject({ kind: 'code', language: 'json', text: '{"ok":true}' });
    const bounded = await parse('```text\nfirst line\nsecond line\n', false, { outputChars: 10 });
    expect(bounded.doc.blocks[0]).toMatchObject({ kind: 'code', text: 'first line' });
    expect(bounded.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('splits escaped table pipes, pads unclosed rows, and leaves invalid separators as prose', async () => {
    const { doc } = await parse('left \\| right | tail\n:---|---:\na\\|b|c\nlast|row');
    expect(doc.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [{ text: 'left | right' }, { text: 'tail' }],
        [{ text: 'a|b' }, { text: 'c' }],
        [{ text: 'last' }, { text: 'row' }],
      ],
    });
    const invalid = await parse('A | B\n--- | --\nnot a table');
    expect(invalid.doc.blocks.every((block) => block.kind !== 'table')).toBe(true);
  });

  it('clips headings and inline runs without exceeding the output character limit', async () => {
    const { doc, warnings } = await parse('# Heading\n\n[label](https://example.test)', true, {
      outputChars: 8,
    });
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', text: 'Heading' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'paragraph', text: '[' });
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('bounds a truncated list and clips the following paragraph line at its separator', async () => {
    const list = await parse('- first\n- second', false, { outputChars: 3 });
    expect(list.doc.blocks[0]).toMatchObject({ kind: 'list', items: [{ text: 'fi' }] });
    expect(list.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    const paragraph = await parse('first\nsecond', false, { outputChars: 8 });
    expect(paragraph.doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'first\nse' });
    expect(paragraph.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('removes the indentation and nested quote markers from blockquote lines', async () => {
    const { doc } = await parse('  > > nested quote\n > second line');
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'nested quote\nsecond line' });
  });
});

describe('Markdown and TXT fuzz entry points', () => {
  const tokens = [
    '- ',
    '* ',
    '1. ',
    '  ',
    '      ',
    '> ',
    '# ',
    '```',
    '~~~',
    '|',
    '---',
    '[',
    '](',
    ')',
    '`',
    '\\',
    '<',
    '>',
    'x',
    '\n',
    '\r\n',
    '\t',
    '=',
  ];
  it('survive seeded mixes of Markdown block and inline syntax', async () => {
    for (let seed = 1; seed <= 300; seed++) {
      let state = seed;
      let source = '';
      for (let step = 0; step < 120; step++) {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        source += tokens[state % tokens.length];
      }
      const bytes = new TextEncoder().encode(source);
      await expect(fuzzMarkdown(bytes)).resolves.toBeUndefined();
      await expect(fuzzTxt(bytes)).resolves.toBeUndefined();
    }
  });
});

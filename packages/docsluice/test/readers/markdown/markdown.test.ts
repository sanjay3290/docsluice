import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import reader from '../../../src/readers/markdown/index.js';

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
});

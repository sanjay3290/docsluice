import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { Limits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ExtractOptions } from '../../../src/core/options.js';
import { emitHtml } from '../../../src/html/index.js';
import { readHtml } from '../../../src/readers/html/read.js';
import { fuzzHtml } from '../../../fuzz/html.fuzz.js';
import { toMarkdown } from '../../../src/render/markdown.js';

function context(
  input: string | Uint8Array,
  limits: Partial<Limits> = {},
  options: ExtractOptions = {},
): ReadContext {
  const budget = new Budget(resolveLimits(limits), { onLimit: options.onLimit, signal: options.signal });
  const resolved = {
    ...options,
    limits: budget.limits,
    onLimit: options.onLimit ?? 'truncate',
    strict: false,
    metadata: true,
    children: 'extract',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  } as const;
  return {
    bytes: typeof input === 'string' ? new TextEncoder().encode(input) : input,
    options: { ...resolved, ...options, limits: budget.limits, strict: false },
    budget,
    warnings: budget.warnings,
    out: new DocBuilder('html', 'text/html', budget, options),
    path: '',
    extractChild: () => Promise.resolve(),
  };
}

describe('HTML reader', () => {
  it('warns and uses detected bytes when a declared charset is unsupported', async () => {
    const ctx = context('<meta charset="docsluice-unsupported"><p>Visible fallback</p>');
    await readHtml(ctx);
    expect(ctx.out.finish()).toMatchObject({
      encoding: 'utf-8',
      blocks: [{ kind: 'paragraph', text: 'Visible fallback' }],
    });
    expect(ctx.warnings.warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });
  it('keeps hidden scopes intact when inner markup closes visible ancestors', async () => {
    for (const markup of [
      '<p>Visible<template><div>SECRET_TEMPLATE</div></template></p>',
      '<ul><li>Visible<noscript><li>SECRET_NOSCRIPT</noscript></ul>',
      '<p>Visible<template></p><div>SECRET_EXPLICIT</div></template><p>After</p>',
    ]) {
      const ctx = context(markup);
      await readHtml(ctx);
      const blocks = JSON.stringify(ctx.out.finish().blocks);
      expect(blocks).toContain('Visible');
      expect(blocks).not.toContain('SECRET_');
    }
  });
  it('executes the bounded fuzz target on malformed delimiters and byte inputs', async () => {
    for (const text of [
      '<'.repeat(2000),
      '<script>hidden</scriptx>still hidden',
      '<p>&#9999999999999999;&missing;</p>',
      '<div>'.repeat(2000),
      '<x ' + 'a="b" '.repeat(1000) + '>text',
    ])
      await fuzzHtml(new TextEncoder().encode(text));
    await fuzzHtml(new Uint8Array(Array.from({ length: 256 }, (_, index) => index)));
  });
  it('counts decoded entity text when applying the output allowance', async () => {
    const fit = context('<p>' + '&amp;'.repeat(10) + '</p>', { outputChars: 10 });
    await readHtml(fit);
    expect(fit.out.finish()).toMatchObject({
      stats: { truncated: false },
      blocks: [{ text: '&'.repeat(10) }],
    });
    const over = context('<p>' + '&#169;'.repeat(12) + '</p>', { outputChars: 10 });
    await readHtml(over);
    expect(over.out.finish()).toMatchObject({
      stats: { truncated: true },
      blocks: [{ text: '©'.repeat(10) }],
    });
  });
  it('applies implied ends through inline ancestors and groups transparent inline text', async () => {
    const ctx = context(
      '<ul><li><b>A<li>B</ul><table><tr><td><b>A<td>B</tr></table><div>Hello <b>world</b>.</div>',
    );
    await readHtml(ctx);
    expect(ctx.out.finish().blocks).toMatchObject([
      { kind: 'list', items: [{ text: 'A' }, { text: 'B' }] },
      { kind: 'table', rows: [[{ text: 'A' }, { text: 'B' }]] },
      { kind: 'paragraph', text: 'Hello world.' },
    ]);
  });
  it('keeps structured visible content and drops executable and hidden content', async () => {
    const ctx = context(
      '<h1>Title</h1><p>One &amp; two.</p><script>SECRET</script><style>STYLE</style><noscript>HIDDEN</noscript><template>TEMPLATE</template><!-- COMMENT --><ul><li>A<li>B</ul><pre><code>x &lt; 2</code></pre><img alt="Diagram">',
    );
    await readHtml(ctx);
    expect(ctx.out.finish()).toMatchObject({
      features: { hasJavaScript: true },
      blocks: [
        { kind: 'heading', level: 1, text: 'Title' },
        { kind: 'paragraph', text: 'One & two.' },
        { kind: 'list', ordered: false, items: [{ text: 'A' }, { text: 'B' }] },
        { kind: 'code', text: 'x < 2' },
        { kind: 'image', alt: 'Diagram' },
      ],
    });
  });
  it('retains href only in runs and flags resources independently of anchors', async () => {
    const ctx = context('<p>See <a href="https://example.invalid/">guide</a>.</p>', {}, { runs: true });
    await readHtml(ctx);
    const doc = ctx.out.finish();
    expect(doc.features.hasExternalLinks).toBe(false);
    expect(doc.blocks[0]).toMatchObject({
      text: 'See guide.',
      runs: [{ text: 'See' }, { text: 'guide', href: 'https://example.invalid/' }, { text: '.' }],
    });
    const resources = context(
      '<img src="https://example.invalid/a" alt="A"><iframe src="https://example.invalid/" onload="SECRET"></iframe>',
    );
    await readHtml(resources);
    expect(resources.out.finish().features).toMatchObject({ hasExternalLinks: true, hasJavaScript: true });
  });
  it('maps merged table cells and implied cell ends', async () => {
    const ctx = context(
      '<table><tr><th rowspan="2">A</th><th colspan="2">B</th></tr><tr><td>C<td>D</tr></table>',
    );
    await readHtml(ctx);
    expect(ctx.out.finish().blocks[0]).toMatchObject({
      kind: 'table',
      headerRows: 1,
      rows: [
        [{ text: 'A', rowSpan: 2 }, { text: 'B', colSpan: 2 }, { text: '' }],
        [{ text: '' }, { text: 'C' }, { text: 'D' }],
      ],
    });
  });

  it('places cells on the grid around spans so renderers keep every value', async () => {
    const ctx = context(
      '<table><tr><td rowspan="3">L</td><td>1</td><td rowspan="2">R</td></tr>' +
        '<tr><td>2</td></tr><tr><td colspan="2">3</td></tr><tr><td>4</td><td>5</td><td>6</td></tr></table>',
    );
    await readHtml(ctx);
    const doc = ctx.out.finish();
    const table = doc.blocks[0];
    expect(table?.kind === 'table' && table.rows.map((row) => row.map((cell) => cell.text))).toEqual([
      ['L', '1', 'R'],
      ['', '2', ''],
      ['', '3', ''],
      ['4', '5', '6'],
    ]);
    expect(toMarkdown(doc)).toContain('| 4 | 5 | 6 |');
    expect(toMarkdown(doc)).toContain('| L | 1 | R |');
    expect(toMarkdown(doc)).toContain('|  | 2 |  |');
  });

  it('clamps spans to the HTML maxima and charges placeholder cells to the cell budget', async () => {
    const ctx = context('<table><tr><td colspan="999999">wide</td></tr></table>', { cells: 50 });
    await readHtml(ctx);
    const table = ctx.out.finish().blocks[0];
    expect(table?.kind === 'table' && table.rows[0]!.length).toBeLessThanOrEqual(50);
    expect(ctx.budget.truncated).toBe(true);
  });
  it('prefers declared meta charset and decodes numeric and common named entities', async () => {
    const head = new TextEncoder().encode('<meta charset="windows-1252"><p>');
    const bytes = new Uint8Array([
      ...head,
      0x93,
      0x63,
      0x61,
      0x66,
      0xe9,
      0x94,
      ...new TextEncoder().encode(' &copy; &#169; &#x1F31F;</p>'),
    ]);
    const ctx = context(bytes);
    await readHtml(ctx);
    expect(ctx.out.finish()).toMatchObject({ encoding: 'windows-1252', blocks: [{ text: '“café” © © 🌟' }] });
  });
  it('limits deep unclosed tags and bounds staged output', async () => {
    const deep = context('<div>'.repeat(100_000) + 'end', { blockDepth: 16, timeMs: 2000 });
    const started = performance.now();
    await readHtml(deep);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(deep.warnings.warnings.some((w) => w.code === 'DEPTH_LIMIT')).toBe(true);
    expect(deep.out.finish().blocks.at(-1)).toMatchObject({ kind: 'paragraph', text: 'end' });
    const small = context('<p>' + 'x'.repeat(100_000) + '</p>', { outputChars: 100 });
    await readHtml(small);
    expect(small.out.finish().stats.truncated).toBe(true);
  });
  it('preserves child location and responds to an already aborted signal', async () => {
    const ctx = { ...context('<p>Child</p>'), path: 'mail/body.html' };
    await readHtml(ctx);
    expect(ctx.out.finish().blocks[0]?.loc.path).toBe('mail/body.html');
    const controller = new AbortController();
    controller.abort();
    await expect(readHtml(context('<p>text</p>', {}, { signal: controller.signal }))).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
  it('flattens elements past blockDepth and keeps their text and later content', async () => {
    for (const onLimit of ['truncate', 'throw'] as const) {
      const html = `${'<div>'.repeat(30)}deep text${'</div>'.repeat(30)}<p>after</p>`;
      const ctx = context(html, { blockDepth: 8 }, { onLimit });
      await readHtml(ctx);
      const doc = ctx.out.finish();
      expect(doc.blocks.map((block) => ('text' in block ? block.text : ''))).toEqual(['deep text', 'after']);
      expect(doc.stats.truncated).toBe(false);
      expect(ctx.warnings.warnings.map((w) => w.code)).toEqual(['DEPTH_LIMIT']);
      expect(ctx.budget.enterDepth('block')).toBe(true);
      ctx.budget.exitDepth('block');
    }
  });
  it('requires a real raw-text closing tag and excludes head text', async () => {
    const ctx = context('<head><title>HEAD</title></head><script>x</scriptx>SECRET</script><p>Visible</p>');
    await readHtml(ctx);
    expect(ctx.out.finish().blocks).toMatchObject([{ kind: 'paragraph', text: 'Visible' }]);
  });
  it('emits inline image alt text and resolves CID references without duplicate images', () => {
    const ctx = context('');
    emitHtml(
      ctx,
      '<p>Look <img alt="Diagram" src="cid:picture"></p>',
      new Map([['picture', 'mail/diagram.png']]),
    );
    expect(ctx.out.finish().blocks).toMatchObject([
      { kind: 'paragraph', text: 'Look Diagram' },
      { kind: 'image', alt: 'Diagram', ref: 'mail/diagram.png' },
    ]);
  });
  it('closes an implied table row and retains its caption', async () => {
    const ctx = context('<table><caption>Summary</caption><tr><td>A<tr><td>B</table>');
    await readHtml(ctx);
    expect(ctx.out.finish().blocks[0]).toMatchObject({
      kind: 'table',
      caption: 'Summary',
      rows: [[{ text: 'A' }], [{ text: 'B' }]],
    });
  });
  it('ignores commented meta charsets and accepts the MIME charset hint', async () => {
    const ctx = context(
      new Uint8Array([
        ...new TextEncoder().encode('<!-- <meta charset="utf-8"> --><p>'),
        0xe9,
        ...new TextEncoder().encode('</p>'),
      ]),
      {},
      { mimeType: 'text/html; charset=windows-1252' },
    );
    await readHtml(ctx);
    expect(ctx.out.finish()).toMatchObject({ encoding: 'windows-1252', blocks: [{ text: 'é' }] });
  });
});

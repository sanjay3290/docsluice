import { describe, expect, it } from 'vitest';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { LimitExceededError, toMarkdown } from '../../src/index.js';

function document(blocks: Block[]): DocsluiceDocument {
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

describe('toMarkdown', () => {
  it('renders every block kind and omits headers and footers by default', () => {
    const blocks: Block[] = [
      { kind: 'heading', level: 2, text: 'Overview', loc: {} },
      {
        kind: 'paragraph',
        text: 'Plain and **bold**, *italic*, `code`, [link](https://example.com)',
        runs: [
          { text: 'Plain and ' },
          { text: 'bold', bold: true },
          { text: ', ' },
          { text: 'italic', italic: true },
          { text: ', ' },
          { text: 'code', code: true },
          { text: ', ' },
          { text: 'link', href: 'https://example.com' },
        ],
        loc: {},
      },
      {
        kind: 'list',
        ordered: true,
        items: [{ text: 'First', items: [{ text: 'Nested' }] }, { text: 'Second' }],
        loc: {},
      },
      {
        kind: 'table',
        rows: [
          [{ text: 'Name' }, { text: 'Value' }],
          [{ text: 'A' }, { text: '1' }],
        ],
        headerRows: 1,
        caption: 'Summary',
        loc: {},
      },
      { kind: 'code', language: 'ts', text: 'const answer = 42;', loc: {} },
      { kind: 'image', alt: 'Diagram', ref: 'assets/diagram.png', loc: {} },
      { kind: 'note', role: 'footnote', text: 'Source note\ncontinued', loc: {} },
      { kind: 'header', text: 'Confidential', loc: {} },
      { kind: 'footer', text: 'Page footer', loc: {} },
      {
        kind: 'section',
        role: 'page',
        blocks: [{ kind: 'paragraph', text: 'Page content', loc: {} }],
        loc: { page: 3 },
      },
      {
        kind: 'section',
        role: 'slide',
        title: 'Title',
        blocks: [],
        loc: { slide: 2 },
      },
      {
        kind: 'section',
        role: 'sheet',
        title: 'Revenue',
        blocks: [],
        loc: { sheet: 'Revenue' },
      },
      { kind: 'section', role: 'part', title: 'Appendix', blocks: [], loc: {} },
    ];

    expect(toMarkdown(document(blocks))).toBe(
      [
        '## Overview',
        'Plain and **bold**, *italic*, `code`, [link](https://example.com)',
        '1. First\n   1. Nested\n2. Second',
        'Summary\n\n| Name | Value |\n| --- | --- |\n| A | 1 |',
        '```ts\nconst answer = 42;\n```',
        '![Diagram](assets/diagram.png)',
        '> Note (footnote): Source note\n> continued',
        '## Page 3\n\nPage content',
        '## Slide 2: Title',
        '## Sheet: Revenue',
        '## Part: Appendix',
      ].join('\n\n'),
    );
    expect(toMarkdown(document(blocks), { headersFooters: true })).toContain('Confidential');
    expect(toMarkdown(document(blocks), { headersFooters: true })).toContain('Page footer');
  });

  it('escapes hostile source text and keeps unsafe run targets visible as text', () => {
    const hostile = [
      '# not a heading',
      '| a | b |',
      '<script>alert(1)</script>',
      '[x](javascript:alert(1))',
      '&lt;h1&gt;entity&lt;/h1&gt;',
      '-->\n<!-- injected -->',
      '---',
    ].join('\n');
    const output = toMarkdown(
      document([
        { kind: 'heading', level: 1, text: hostile, loc: {} },
        {
          kind: 'paragraph',
          text: 'untrusted run',
          runs: [
            { text: 'unsafe link', href: 'javascript:alert(1)' },
            { text: 'data link', href: 'data:text/html,<script>x</script>' },
          ],
          loc: {},
        },
        { kind: 'image', alt: 'unsafe', ref: 'javascript:alert(1)', loc: {} },
      ]),
    );

    expect(output).toContain('\\# not a heading');
    expect(output).toContain('| a | b |');
    expect(output).not.toContain('| --- | --- |');
    expect(output).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(output).toContain('\\[x\\](javascript:alert(1))');
    expect(output).toContain('&lt;h1&gt;entity&lt;/h1&gt;');
    expect(output).toContain('--&gt;');
    expect(output).not.toContain('<!-- injected -->');
    expect(output).not.toContain('[unsafe link](javascript:');
    expect(output).not.toContain('[data link](data:');
    expect(output).toContain('unsafe link (javascript:alert(1))');
    expect(output).toContain('unsafe (javascript:alert(1))');
  });

  it('escapes raw HTML tag starts even when tags and attributes span lines', () => {
    const hostile = [
      '<script\n>alert(1)//',
      '<svg\n onload="alert(2)">x</svg>',
      '<a\n href="javascript:alert(3)"\n onclick="alert(4)">x</a>',
      '<!--\n<script>alert(5)</script>\n-->',
      '<!DOCTYPE\nhtml>',
      '<?xml\nversion="1.0"?>',
      '<svg\n onload="alert(6)"',
    ].join('\n');
    const output = toMarkdown(document([{ kind: 'paragraph', text: hostile, loc: {} }]));

    expect(output).toContain('&lt;script\n&gt;alert(1)//');
    expect(output).toContain('&lt;svg\n onload="alert(2)"&gt;x&lt;/svg&gt;');
    expect(output).toContain('&lt;a\n href="javascript:alert(3)"\n onclick="alert(4)"&gt;');
    expect(output).toContain('&lt;!--');
    expect(output).toContain('&lt;!DOCTYPE\nhtml&gt;');
    expect(output).toContain('&lt;?xml\nversion="1.0"?&gt;');
    expect(output).toContain('&lt;svg\n onload="alert(6)"');
    expect(output).not.toMatch(/<(?:script|svg|a|!DOCTYPE|\?xml)\b/i);
  });

  it('keeps repeated HTML prefixes and deeply unmatched brackets bounded and deterministic', () => {
    const htmlPrefixes = '<a'.repeat(5_000);
    const unmatchedBrackets = '['.repeat(5_000);
    const doc = document([
      { kind: 'paragraph', text: htmlPrefixes, loc: {} },
      { kind: 'paragraph', text: unmatchedBrackets, loc: {} },
    ]);
    const output = toMarkdown(doc);

    expect(output.split('\n\n')[0]).toBe('&lt;a'.repeat(5_000));
    expect(output.split('\n\n')[1]).toBe('\\['.repeat(5_000));
  });

  it('escapes brackets in generated image and run-link labels', () => {
    const doc = document([
      { kind: 'image', alt: 'x](javascript:alert(1)', ref: 'https://safe.example/i.png', loc: {} },
      {
        kind: 'paragraph',
        text: 'ignored',
        runs: [
          { text: 'x](javascript:alert(2)', href: 'https://safe.example/run' },
          { text: '[nested] and unmatched ]', href: 'https://safe.example/brackets' },
        ],
        loc: {},
      },
    ]);
    const output = toMarkdown(doc);

    expect(output).toContain('![x\\](javascript:alert(1)](https://safe.example/i.png)');
    expect(output).toContain('[x\\](javascript:alert(2)](https://safe.example/run)');
    expect(output).toContain('[\\[nested\\] and unmatched \\]](https://safe.example/brackets)');
    expect(output).not.toMatch(/(?<!\\)\]\(javascript:alert\(/);
  });

  it('renders section markers as headings, safe comments, or not at all', () => {
    const doc = document([
      {
        kind: 'section',
        role: 'slide',
        title: 'Intro --> <!-- forged',
        blocks: [{ kind: 'paragraph', text: 'Body', loc: {} }],
        loc: { slide: 2 },
      },
    ]);

    expect(toMarkdown(doc)).toBe('## Slide 2: Intro --> &lt;!-- forged\n\nBody');
    const comment = toMarkdown(doc, { sections: 'comment' });
    expect(comment).toContain('<!-- Slide 2: Intro');
    expect(comment).not.toContain('<!-- forged -->');
    expect(toMarkdown(doc, { sections: 'none' })).toBe('Body');
  });

  it('uses a longer safe fence and omits unsafe language info strings', () => {
    const doc = document([
      { kind: 'code', text: 'before\n```\n````\nafter', language: 'ts', loc: {} },
      { kind: 'code', text: 'plain', language: 'ts\n<script>', loc: {} },
    ]);
    expect(toMarkdown(doc)).toBe('`````ts\nbefore\n```\n````\nafter\n`````\n\n```\nplain\n```');
  });

  it('keeps ordinary punctuation readable while escaping actual Markdown syntax', () => {
    const doc = document([
      {
        kind: 'paragraph',
        text: 'well-known; 2 * 3; 4 < 5; 6 > 2; _emphasis_\n# heading\n- item\n---\nTitle\n===\n    code\n~~strike~~',
        loc: {},
      },
    ]);
    expect(toMarkdown(doc)).toBe(
      'well-known; 2 * 3; 4 < 5; 6 > 2; \\_emphasis\\_\n\\# heading\n\\- item\n\\---\nTitle\n\\=\\=\\=\n&#32;   code\n\\~\\~strike\\~\\~',
    );
  });

  it('escapes source GFM table syntax without changing ordinary pipe text', () => {
    const doc = document([{ kind: 'paragraph', text: 'A | B\n--- | ---\nordinary a | b | c', loc: {} }]);
    const output = toMarkdown(doc);
    expect(output).toContain('A \\| B\n--- \\| ---');
    expect(output).toContain('ordinary a | b | c');
  });

  it('flattens merged cells, line breaks, and pipes according to ADR 0007', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [{ text: 'Merged', rowSpan: 2, colSpan: 2 }, { text: 'covered' }, { text: 'Tail' }],
          [{ text: 'covered row' }, { text: 'covered col' }, { text: 'line 1\nline 2' }],
        ],
        loc: {},
      },
    ]);
    expect(toMarkdown(doc)).toBe('| Merged |  | Tail |\n| --- | --- | --- |\n|  |  | line 1<br>line 2 |');
  });

  it('leaves horizontally covered cells blank in flattened tables', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [[{ text: 'Merged', colSpan: 2 }, { text: 'Covered' }, { text: 'Tail' }]],
        loc: {},
      },
    ]);
    expect(toMarkdown(doc)).toBe('| Merged |  | Tail |\n| --- | --- | --- |');
  });

  it('uses spreadsheet addresses to preserve compact cells after horizontal merges', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [
            { text: 'Merged', rowSpan: 2, colSpan: 2, address: 'Merged!A1' },
            { text: 'C header', address: 'Merged!C1' },
          ],
          [{ text: 'C value', address: 'Merged!C2' }],
        ],
        loc: {},
      },
    ]);

    expect(toMarkdown(doc)).toBe('| Merged |  | C header |\n| --- | --- | --- |\n|  |  | C value |');
    expect(toMarkdown(doc, { tables: 'html' })).toBe(
      '<table>\n<tbody>\n<tr><th rowspan="2" colspan="2">Merged</th><th>C header</th></tr>\n<tr><td>C value</td></tr>\n</tbody>\n</table>',
    );
  });

  it('places addressed cells relative to the table first column, not the sheet', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [
            { text: 'Y', address: 'Y90000' },
            { text: 'Z', address: 'Z90000' },
          ],
          [{ text: 'Z only', address: 'Z90001' }],
        ],
        loc: {},
      },
    ]);

    expect(toMarkdown(doc)).toBe('| Y | Z |\n| --- | --- |\n|  | Z only |');
  });

  it('preserves address gaps in HTML table rows', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [[{ text: 'A', address: 'Sheet!A1' }], [{ text: 'C\nvalue', address: 'Sheet!C2' }]],
        loc: {},
      },
    ]);

    expect(toMarkdown(doc, { tables: 'html' })).toBe(
      '<table>\n<tbody>\n<tr><th>A</th></tr>\n<tr><td></td><td></td><td>C<br>value</td></tr>\n</tbody>\n</table>',
    );
  });

  it('orders HTML table cells by physical spreadsheet column', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 0,
        rows: [
          [
            { text: 'C\ncell', address: 'S!C1' },
            { text: 'A', address: 'S!A1' },
          ],
        ],
        loc: {},
      },
    ]);

    expect(toMarkdown(doc, { tables: 'html' })).toBe(
      '<table>\n<tbody>\n<tr><td>A</td><td></td><td>C<br>cell</td></tr>\n</tbody>\n</table>',
    );
  });

  it('keeps repeated spreadsheet addresses within the table row width', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 0,
        rows: [
          [
            { text: 'C1\nvalue', address: 'S!C1' },
            { text: 'duplicate', address: 'S!C1' },
          ],
        ],
        loc: {},
      },
    ]);

    // C is the table's first addressed column; the duplicate falls back to its source position.
    expect(toMarkdown(doc, { tables: 'html' })).toBe(
      '<table>\n<tbody>\n<tr><td>C1<br>value</td><td>duplicate</td></tr>\n</tbody>\n</table>',
    );
  });

  it('keeps dense covered placeholders blank while preserving the following cell', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [[{ text: 'Merged', colSpan: 2 }, { text: '' }, { text: 'Next' }]],
        loc: {},
      },
    ]);

    expect(toMarkdown(doc)).toBe('| Merged |  | Next |\n| --- | --- | --- |');
  });

  it('does not count simple tables twice when HTML output is requested', () => {
    const rows: Array<Array<{ text: string }>> = [];
    for (let index = 0; index < 335_000; index++) rows.push([{ text: '' }, { text: '' }]);
    const doc = document([{ kind: 'table', headerRows: 0, rows, loc: {} }]);

    expect(() =>
      toMarkdown(doc, { tables: 'html', maxTableRows: rows.length, maxTableColumns: 2 }),
    ).not.toThrow();
  }, 120_000);

  it('allows exact-limit HTML table output and rejects one character over', () => {
    const render = (textLength: number): string =>
      toMarkdown(
        document([
          {
            kind: 'table',
            headerRows: 1,
            rows: [[{ text: 'x'.repeat(textLength), rowSpan: 2 }], []],
            loc: {},
          },
        ]),
        { tables: 'html' },
      );

    expect(render(19_999_926)).toHaveLength(20_000_000);
    expect(() => render(19_999_927)).toThrow(LimitExceededError);
  }, 120_000);

  it('keeps hostile table cell text literal in both table modes', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [{ text: 'Header' }, { text: 'Other' }],
          [{ text: '<script>alert(1)</script>' }, { text: '[x](javascript:alert(1)) | &lt;' }],
        ],
        loc: {},
      },
    ]);
    const flattened = toMarkdown(doc);
    expect(flattened).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(flattened).toContain('\\[x\\](javascript:alert(1)) \\| &lt;');
    const html = toMarkdown(doc, { tables: 'html' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('\\[x\\](javascript:alert(1)) \\| &lt;');
  });

  it('uses escaped HTML with spans for merged and multiline tables when opted in', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [{ text: '<Merged &>', rowSpan: 2, colSpan: 2 }, { text: 'covered' }, { text: 'Tail' }],
          [{ text: 'covered row' }, { text: 'covered column' }, { text: 'line 1\nline 2' }],
        ],
        loc: {},
      },
    ]);
    expect(toMarkdown(doc, { tables: 'html' })).toBe(
      '<table>\n<tbody>\n<tr><th rowspan="2" colspan="2">&lt;Merged &amp;&gt;</th><th>Tail</th></tr>\n<tr><td>line 1<br>line 2</td></tr>\n</tbody>\n</table>',
    );
  });

  it('caps rows and columns and reports both omitted counts', () => {
    const doc = document([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [{ text: 'A' }, { text: 'B' }, { text: 'C' }],
          [{ text: '1' }, { text: '2' }, { text: '3' }],
          [{ text: '4' }, { text: '5' }, { text: '6' }],
          [{ text: '7' }, { text: '8' }, { text: '9' }],
        ],
        loc: {},
      },
    ]);
    expect(toMarkdown(doc, { maxTableRows: 2, maxTableColumns: 2 })).toBe(
      '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n… 2 more rows and 1 more column not shown',
    );
  });

  it('renders nested lists iteratively and deterministically within the internal depth limit', () => {
    const root = { text: 'item' } as { text: string; items?: (typeof root)[] };
    let current = root;
    for (let depth = 0; depth < 40; depth++) {
      current.items = [{ text: 'item' }];
      current = current.items[0]!;
    }
    const output = toMarkdown(document([{ kind: 'list', ordered: false, items: [root], loc: {} }]));
    expect(output.startsWith('- item\n  - item\n    - item')).toBe(true);
    expect(toMarkdown(document([{ kind: 'list', ordered: false, items: [root], loc: {} }]))).toBe(output);
  });

  it('applies the default block-depth and output-character budgets', () => {
    const root = { text: 'item' } as { text: string; items?: (typeof root)[] };
    let current = root;
    for (let depth = 0; depth < 70; depth++) {
      current.items = [{ text: 'item' }];
      current = current.items[0]!;
    }
    expect(() => toMarkdown(document([{ kind: 'list', ordered: false, items: [root], loc: {} }]))).toThrow(
      LimitExceededError,
    );

    const oversized = 'x'.repeat(20_000_001);
    expect(() => toMarkdown(document([{ kind: 'code', text: oversized, language: 'txt', loc: {} }]))).toThrow(
      LimitExceededError,
    );
  });

  it('rejects cyclic section arrays instead of walking them forever', () => {
    const blocks: Block[] = [];
    const section: Block = { kind: 'section', role: 'part', blocks, loc: {} };
    blocks.push(section);
    expect(() => toMarkdown(document(blocks))).toThrow('Document blocks must not contain cycles.');
  });
});

import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { ResolvedOptions } from '../../src/core/options.js';
import { WarningSink } from '../../src/core/warnings.js';
import { scanDocxBody } from '../../src/readers/docx/body.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const base = (runs = false, warnings = new WarningSink()) => {
  const budget = new Budget({ ...DEFAULT_LIMITS }, { warnings });
  const options = { runs, limits: { ...DEFAULT_LIMITS } } as ResolvedOptions;
  const out = new DocBuilder(
    'docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    budget,
    options,
  );
  return { budget, warnings, options, out, path: 'word/document.xml' };
};

describe('scanDocxBody', () => {
  it('emits paragraphs and headings in order, including table, SDT, and textbox content', () => {
    const ctx = base();
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body>
        <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>First</w:t></w:r></w:p>
        <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
        <w:sdt><w:sdtContent><w:p><w:r><w:t>Control</w:t></w:r></w:p></w:sdtContent></w:sdt>
        <w:p><w:r><w:t>before</w:t><w:drawing><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></w:drawing><w:t>after</w:t></w:r></w:p>
      </w:body></w:document>`,
      ctx,
      new Map([['Heading1', { id: 'Heading1', level: 1 as const }]]),
      new Map(),
    );
    expect(
      ctx.out
        .finish()
        .blocks.map((block) => [
          block.kind,
          block.kind === 'heading' || block.kind === 'paragraph' ? block.text : '',
        ]),
    ).toEqual([
      ['heading', 'First'],
      ['paragraph', 'Cell'],
      ['paragraph', 'Control'],
      ['paragraph', 'before'],
      ['paragraph', 'Box'],
      ['paragraph', 'after'],
    ]);
  });

  it('does not double-charge streamed paragraphs against the output character limit', () => {
    const warnings = new WarningSink();
    const budget = new Budget({ ...DEFAULT_LIMITS, outputChars: 8 }, { warnings });
    const options = { runs: false, limits: { ...DEFAULT_LIMITS, outputChars: 8 } } as ResolvedOptions;
    const out = new DocBuilder('docx', 'application/docx', budget, options);
    const ctx = { ...base(false, warnings), budget, out };
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>aa</w:t></w:r></w:p><w:p><w:r><w:t>bb</w:t></w:r></w:p><w:p><w:r><w:t>cc</w:t></w:r></w:p></w:body></w:document>`,
      ctx,
      new Map(),
      new Map(),
    );
    expect(out.finish().blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      'aa',
      'bb',
      'cc',
    ]);
    expect(budget.truncated).toBe(false);
  });

  it('uses namespace URI and attribute namespace instead of matching raw spoofed names', () => {
    const ctx = base();
    scanDocxBody(
      `<x:document xmlns:x="${W}" xmlns:w="urn:spoof"><x:body>
        <x:p><x:pPr><x:pStyle w:val="Spoof" x:val="Heading2"/></x:pPr><x:r><x:t>real namespace</x:t></x:r></x:p>
        <w:p><w:r><w:t>spoof ignored</w:t></w:r></w:p>
      </x:body></x:document>`,
      ctx,
      new Map([['Heading2', { id: 'Heading2', level: 2 as const }]]),
      new Map(),
    );
    const blocks = ctx.out.finish().blocks;
    expect(blocks).toMatchObject([{ kind: 'heading', level: 2, text: 'real namespace' }]);
  });

  it('treats a direct paragraph outline level as a heading level that overrides the style', () => {
    const ctx = base();
    const styles = new Map([['Heading1', { id: 'Heading1', level: 1 as const }]]);
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body>` +
        `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>Custom</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:outlineLvl w:val="9"/></w:pPr><w:r><w:t>Body text</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:outlineLvl w:val="7"/></w:pPr><w:r><w:t>Deep</w:t></w:r></w:p>` +
        `<w:p><w:pPr><w:rPr><w:outlineLvl w:val="0"/></w:rPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p>` +
        `</w:body></w:document>`,
      ctx,
      styles,
      new Map(),
    );
    expect(ctx.out.finish().blocks).toMatchObject([
      { kind: 'heading', level: 3, text: 'Custom' },
      { kind: 'paragraph', text: 'Body text' },
      { kind: 'paragraph', text: 'Deep' },
      { kind: 'paragraph', text: 'Nested' },
    ]);
  });

  it('recognizes built-in heading ids when styles.xml omits their declarations', () => {
    const ctx = base();
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Heading</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p></w:body></w:document>`,
      ctx,
      new Map(),
      new Map(),
    );
    expect(ctx.out.finish().blocks).toMatchObject([
      { kind: 'heading', level: 1, text: 'Heading' },
      { kind: 'heading', level: 1, text: 'Title' },
    ]);
  });

  it('selects a supported AlternateContent Choice once and falls back for unknown requirements', () => {
    const ctx = base();
    scanDocxBody(
      `<w:document xmlns:w="${W}" xmlns:mc="${MC}" xmlns:x="urn:unsupported"><w:body>
        <mc:AlternateContent><mc:Choice Requires="x"><w:p><w:r><w:t>unsupported-choice</w:t></w:r></w:p></mc:Choice><mc:Choice Requires="w"><w:p><w:r><w:t>chosen</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>duplicate</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>
        <mc:AlternateContent><mc:Choice Requires="x"><w:p><w:r><w:t>unsupported</w:t></w:r></w:p></mc:Choice><mc:Fallback><w:p><w:r><w:t>fallback</w:t></w:r></w:p></mc:Fallback></mc:AlternateContent>
      </w:body></w:document>`,
      ctx,
      new Map(),
      new Map(),
    );
    expect(ctx.out.finish().blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      'chosen',
      'fallback',
    ]);
  });

  it('keeps visible hyperlink text and optionally records run emphasis and relationship URLs', () => {
    const ctx = base(true);
    scanDocxBody(
      `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p>
        <w:hyperlink r:id="r1"><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>linked</w:t></w:r></w:hyperlink>
        <w:hyperlink w:anchor="mark"><w:r><w:t>anchor</w:t></w:r></w:hyperlink>
        <w:r><w:instrText>SECRET CODE</w:instrText><w:tab/><w:t>shown</w:t><w:br/><w:t>next</w:t></w:r>
      </w:p></w:body></w:document>`,
      ctx,
      new Map(),
      new Map([['r1', { target: 'https://example.test/path', external: true }]]),
    );
    const result = ctx.out.finish().blocks[0];
    expect(result).toMatchObject({
      kind: 'paragraph',
      text: 'linkedanchor\tshown\nnext',
      runs: [
        { text: 'linked', bold: true, italic: true, href: 'https://example.test/path' },
        { text: 'anchor\tshown\nnext' },
      ],
    });
  });

  it('offers paragraph numbering and style metadata to an optional handler', () => {
    const ctx = base();
    const seen: Array<{ text: string; styleId?: string; level?: number; numId?: string; ilvl?: number }> = [];
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body><w:p><w:pPr><w:pStyle w:val="CustomHeading"/><w:numPr><w:ilvl w:val="1"/><w:numId w:val="__proto__"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p></w:body></w:document>`,
      ctx,
      new Map([['CustomHeading', { id: 'CustomHeading', level: 2 as const }]]),
      new Map(),
      (paragraph) => {
        seen.push(paragraph);
        return true;
      },
    );
    expect(seen).toEqual([
      {
        text: 'item',
        styleId: 'CustomHeading',
        level: 2,
        numId: '__proto__',
        ilvl: 1,
        loc: { path: 'word/document.xml' },
      },
    ]);
    expect(ctx.out.finish().blocks).toEqual([]);
  });

  it('only reads style and numbering properties directly inside paragraph properties', () => {
    const ctx = base();
    const seen: Array<{ text: string; styleId?: string; numId?: string; ilvl?: number }> = [];
    scanDocxBody(
      `<w:document xmlns:w="${W}" xmlns:e="urn:extension"><w:body><w:p><e:wrapper><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="8"/><w:ilvl w:val="2"/></w:numPr></w:pPr></e:wrapper><w:r><w:t>plain</w:t></w:r></w:p></w:body></w:document>`,
      ctx,
      new Map([['Heading1', { id: 'Heading1', level: 1 as const }]]),
      new Map(),
      (paragraph) => {
        seen.push(paragraph);
        return true;
      },
    );
    expect(seen).toEqual([{ text: 'plain', loc: { path: 'word/document.xml' } }]);
  });

  it('stops safely on deep SDTs, output limits, abort, and strict malformed XML', () => {
    const deep = base();
    scanDocxBody(
      `<w:document xmlns:w="${W}"><w:body>${'<w:sdt>'.repeat(10_000)}<w:sdtContent><w:p><w:r><w:t>x</w:t></w:r></w:p></w:sdtContent>${'</w:sdt>'.repeat(10_000)}</w:body></w:document>`,
      deep,
      new Map(),
      new Map(),
    );
    expect(deep.budget.truncated).toBe(true);
    expect(deep.warnings.warnings[0]?.code).toBe('TRUNCATED');

    const limited = base();
    const limitedBudget = new Budget({ ...DEFAULT_LIMITS, outputChars: 2 }, { warnings: limited.warnings });
    const limitedOut = new DocBuilder('docx', 'application/docx', limitedBudget, limited.options);
    expect(() =>
      scanDocxBody(
        `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>overflow</w:t></w:r></w:p></w:body></w:document>`,
        { ...limited, budget: limitedBudget, out: limitedOut },
        new Map(),
        new Map(),
      ),
    ).not.toThrow();
    expect(limitedBudget.truncated).toBe(true);

    const controller = new AbortController();
    controller.abort();
    const aborted = new Budget({ ...DEFAULT_LIMITS }, { signal: controller.signal });
    const abortCtx = { ...base(), budget: aborted };
    expect(() => scanDocxBody(`<w:document xmlns:w="${W}"/>`, abortCtx, new Map(), new Map())).toThrow();

    const strict = base(false, new WarningSink({ strict: ['UNREADABLE_PART'] }));
    expect(() =>
      scanDocxBody(`<w:document xmlns:w="${W}"><w:body></w:document>`, strict, new Map(), new Map()),
    ).toThrow();
  });
});

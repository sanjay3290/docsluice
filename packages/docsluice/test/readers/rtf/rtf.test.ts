import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { WarningSink } from '../../../src/core/warnings.js';
import reader, { deencapsulateRtfHtml } from '../../../src/readers/rtf/index.js';
import { fuzzRtf } from '../../../fuzz/rtf.fuzz.js';

async function parse(
  source: string | Uint8Array,
  limits: Record<string, number> = {},
  signal?: AbortSignal,
  runs = false,
) {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings, signal });
  const options = { limits: budget.limits, runs } as ResolvedOptions;
  const out = new DocBuilder('rtf', 'application/rtf', budget, options);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings, budget };
}

function expectBlockDepthAvailable(budget: Budget, maximum: number): void {
  let attempts = 0;
  try {
    for (; attempts < maximum;) {
      attempts += 1;
      expect(budget.enterDepth('block')).toBe(true);
    }
  } finally {
    while (attempts > 0) {
      budget.exitDepth('block');
      attempts -= 1;
    }
  }
}

describe('RTF reader', () => {
  it('detects only the RTF document signature', () => {
    const detect = reader.detect?.bind(reader);
    expect(detect).toBeDefined();
    if (!detect) throw new Error('RTF reader has no detector');
    expect(detect(new TextEncoder().encode(String.raw`{\rtf1 text}`))).toBe(1);
    expect(detect(new TextEncoder().encode(String.raw`{\RTF1 text}`))).toBe(0);
    expect(detect(new Uint8Array([123, 92, 114, 116]))).toBe(0);
    expect(reader.mimeTypes).toEqual(['application/rtf']);
  });

  it('reads the authored corpus fixtures for Unicode, lists, tables, and damaged binary data', async () => {
    const wordpad = await parse(
      readFileSync(new URL('../../../../../corpus/rtf/wordpad-unicode.rtf', import.meta.url)),
    );
    expect(wordpad.doc.metadata).toMatchObject({ title: 'Fixture note', authors: ['Test Author'] });
    expect(wordpad.doc.blocks).toHaveLength(2);
    const wordpadFirst = wordpad.doc.blocks[0];
    expect(wordpadFirst?.kind === 'paragraph' && wordpadFirst.text).toContain('☃');

    const japanese = await parse(
      readFileSync(new URL('../../../../../corpus/rtf/japanese-codepage.rtf', import.meta.url)),
    );
    const japaneseFirst = japanese.doc.blocks[0];
    expect(japaneseFirst?.kind === 'paragraph' && japaneseFirst.text).toContain('あ');

    const tableAndList = await parse(
      readFileSync(new URL('../../../../../corpus/rtf/table-and-list.rtf', import.meta.url)),
    );
    expect(tableAndList.doc.blocks.map((block) => block.kind)).toContain('list');
    expect(tableAndList.doc.blocks.map((block) => block.kind)).toContain('table');

    const damaged = await parse(
      readFileSync(new URL('../../../../../corpus/rtf/bin-overrun.rtf', import.meta.url)),
    );
    expect(damaged.doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Before' });
    expect(damaged.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('decodes hex escapes, Unicode fallback and keeps formatting groups isolated', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1\ansi\ansicpg1252\uc1 Before \'e9 and \u9731? after {\b Bold} plain\par}`,
    );
    expect(doc.blocks).toEqual([{ kind: 'paragraph', text: 'Before é and ☃ after Bold plain', loc: {} }]);
    expect(doc.encoding).toBe('windows-1252');
  });

  it('uses Windows-1252 after an unsupported code page instead of a stale decoder', async () => {
    const { doc, warnings } = await parse(String.raw`{\rtf1\ansi\ansicpg65001\ansicpg9999 \'e9\par}`);
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'é' });
    expect(doc.encoding).toBe('windows-1252');
    expect(warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });

  it('extracts recognized OXRTFEX HTML and skips MHTML and htmlrtf-only text', () => {
    const source = String.raw`{\rtf1\ansi\fromhtml1{\*\htmltag64}<p>caf\'e9 \u9731?</p>}{\*\mhtmltag1 rewritten}{\htmlrtf hidden\htmlrtf0}visible}`;
    const budget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(deencapsulateRtfHtml(new TextEncoder().encode(source), budget)).toBe('<p>café ☃</p>visible');
    const ordinary = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(deencapsulateRtfHtml(new TextEncoder().encode(String.raw`{\rtf1 ordinary}`), ordinary)).toBe(
      undefined,
    );
  });

  it('decodes HTML fragments with the declared code page and skips binary braces', () => {
    const budget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(
      deencapsulateRtfHtml(
        new TextEncoder().encode(String.raw`{\rtf1\ansi\ansicpg932\fromhtml1{\*\htmltag1}<p>\'82\'a0</p>}}`),
        budget,
      ),
    ).toBe('<p>あ</p>');

    const prefix = new TextEncoder().encode(String.raw`{\rtf1\ansi\fromhtml1{\*\htmltag1}<p>a\bin4 `);
    const suffix = new TextEncoder().encode('b</p>}}');
    const bytes = new Uint8Array(prefix.length + 4 + suffix.length);
    bytes.set(prefix);
    bytes.set([125, 123, 92, 125], prefix.length);
    bytes.set(suffix, prefix.length + 4);
    const binaryBudget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(deencapsulateRtfHtml(bytes, binaryBudget)).toBe('<p>ab</p>');
    expectBlockDepthAvailable(binaryBudget, binaryBudget.limits.blockDepth);
  });

  it('returns no HTML when its shared output budget is exhausted and balances depth', () => {
    const budget = new Budget(resolveLimits({ outputChars: 4 }), { warnings: new WarningSink() });
    expect(
      deencapsulateRtfHtml(
        new TextEncoder().encode(String.raw`{\rtf1\fromhtml1{\*\htmltag1}long text}`),
        budget,
      ),
    ).toBeUndefined();
    expectBlockDepthAvailable(budget, budget.limits.blockDepth);
  });

  it('recognizes HTML in the initial token window, tracks helper font code pages and cleans up depth limits', () => {
    const nestedBudget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(
      deencapsulateRtfHtml(
        new TextEncoder().encode(String.raw`{\rtf1{\ansi\fromhtml1{\*\htmltag1}<p>nested</p>}}`),
        nestedBudget,
      ),
    ).toBe('<p>nested</p>');

    const fontBudget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(
      deencapsulateRtfHtml(
        new TextEncoder().encode(
          String.raw`{\rtf1\ansi\fromhtml1{\fonttbl{\f0\fcharset128 Japan;}}\f0{\*\htmltag1}<p>\'82\'a0</p>}`,
        ),
        fontBudget,
      ),
    ).toBe('<p>あ</p>');

    const limitedBudget = new Budget(resolveLimits({ blockDepth: 1 }), { warnings: new WarningSink() });
    expect(
      deencapsulateRtfHtml(
        new TextEncoder().encode(String.raw`{\rtf1\fromhtml1{\*\htmltag1}too deep}`),
        limitedBudget,
      ),
    ).toBeUndefined();
    expectBlockDepthAvailable(limitedBudget, limitedBudget.limits.blockDepth);
    const invalidHeaderBudget = new Budget(resolveLimits(), { warnings: new WarningSink() });
    expect(deencapsulateRtfHtml(new TextEncoder().encode('not RTF'), invalidHeaderBudget)).toBeUndefined();
  });

  it('keeps bold and italic runs only when requested', async () => {
    const { doc } = await parse(String.raw`{\rtf1\b Bold \i italic\i0\b0 plain}`, {}, undefined, true);
    expect(doc.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'Bold italicplain',
      runs: [{ text: 'Bold', bold: true }, { text: ' italic', bold: true, italic: true }, { text: 'plain' }],
    });
  });

  it('extracts document metadata, outline headings, lists, and tables', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1{\info{\title Sample title}{\author A Writer}}\pard\outlinelevel0 Heading\par\pard\ls1\ilvl0\bullet\tab First item\par\trowd\cellx1500\cellx3000\intbl Left\cell Right\cell\row}`,
    );
    expect(doc.metadata).toEqual({ title: 'Sample title', authors: ['A Writer'] });
    expect(doc.blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'table']);
    expect(doc.blocks[0]).toMatchObject({ kind: 'heading', level: 1, text: 'Heading' });
    expect(doc.blocks[1]).toMatchObject({
      kind: 'list',
      ordered: false,
      items: [{ text: 'First item', marker: '•' }],
    });
    expect(doc.blocks[2]).toMatchObject({ kind: 'table', rows: [[{ text: 'Left' }, { text: 'Right' }]] });
  });

  it('reads all info field groups and rejects invalid date components', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1{\info{\title A title}{\author Alice}{\author Bob}{\subject Topic}{\keywords red; blue}{\doccomm Comment}{\creatim\yr2024\mo2\dy29\hr23\min59\sec59}{\revtim\yr2024\mo13\dy1\hr0\min0\sec0}}Body}`,
    );
    expect(doc.metadata).toEqual({
      title: 'A title',
      authors: ['Alice', 'Bob'],
      created: '2024-02-29T23:59:59Z',
      custom: [
        { name: 'subject', value: 'Topic' },
        { name: 'keywords', value: 'red; blue' },
        { name: 'comments', value: 'Comment' },
      ],
    });
  });

  it('caps oversized metadata and warns when too many metadata fields are supplied', async () => {
    const oversized = 'x'.repeat(5000);
    const largeValue = await parse(String.raw`{\rtf1{\info{\author ${oversized}}}}`);
    expect(largeValue.doc.metadata.authors?.[0]).toHaveLength(4096);

    const authors = Array.from({ length: 1025 }, (_, index) => `{\\author A${index}}`).join('');
    const manyFields = await parse(`{\\rtf1{\\info${authors}}}`);
    expect(manyFields.doc.metadata.authors).toHaveLength(1024);
    expect(manyFields.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('keeps header/footer text, emits picture placeholders and skips formatting destinations', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1{\colortbl;\red0\green0\blue0;}{\stylesheet{\s0 Normal;}}{\header Header text}{\footer Footer text}Body\par{\pict\pngblip\bin4 data}After}`,
    );
    expect(doc.blocks.map(({ kind }) => kind)).toEqual([
      'header',
      'footer',
      'paragraph',
      'image',
      'paragraph',
    ]);
    expect(doc.blocks[0]).toMatchObject({ kind: 'header', text: 'Header text' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'footer', text: 'Footer text' });
    expect(doc.blocks[3]).toMatchObject({ kind: 'image', mimeType: 'image/unknown' });
  });

  it('supports style headings, escaped characters, and malformed hex safely', async () => {
    const { doc, warnings } = await parse(
      String.raw`{\rtf1\s1 One\par\s6 Six\par\outlinelevel-4 Clamp\par\pard Escaped \{brace\} \\slash\~space\_join\-opt \'xz\par}`,
    );
    expect(doc.blocks.slice(0, 3)).toMatchObject([
      { kind: 'heading', level: 1, text: 'One' },
      { kind: 'heading', level: 6, text: 'Six' },
      { kind: 'heading', level: 1, text: 'Clamp' },
    ]);
    expect(doc.blocks[3]).toMatchObject({
      kind: 'paragraph',
      text: 'Escaped {brace} \\slash space‑joinopt',
    });
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('normalizes line breaks and safely warns about malformed binary and trailing control syntax', async () => {
    const bytes = new TextEncoder().encode('{\\rtf1 first\\line second\r\nthird\\bin text}\\');
    const { doc, warnings } = await parse(bytes);
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'first\nsecondthirdtext' });
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('nests list items from the RTF list level control', async () => {
    const { doc } = await parse(String.raw`{\rtf1\ls1\ilvl0 Parent\par\ls1\ilvl1 Child\par\pard}`);
    expect(doc.blocks[0]).toMatchObject({
      kind: 'list',
      items: [{ text: 'Parent', items: [{ text: 'Child' }] }],
    });
  });

  it('starts a new list on list-id changes and ends lists before ordinary paragraphs', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1\ls1\ilvl0 First\par\ls2\ilvl0 Second\par\pard Ordinary\par}`,
    );
    expect(doc.blocks.map(({ kind }) => kind)).toEqual(['list', 'list', 'paragraph']);
    expect(doc.blocks[0]).toMatchObject({ kind: 'list', items: [{ text: 'First' }] });
    expect(doc.blocks[1]).toMatchObject({ kind: 'list', items: [{ text: 'Second' }] });
    expect(doc.blocks[2]).toMatchObject({ kind: 'paragraph', text: 'Ordinary' });
  });

  it('stops building a table when the shared cell budget is exhausted', async () => {
    const { doc, warnings } = await parse(String.raw`{\rtf1\trowd First\cell Second\cell\row}`, { cells: 1 });
    expect(doc.stats.truncated).toBe(true);
    expect(doc.blocks).toEqual([]);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('retains horizontal table merge spans', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1\trowd\clmgf\cellx1000 Merged\cell\clmrg\cellx2000\cell\row}`,
    );
    expect(doc.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: 'Merged', colSpan: 2 }]],
    });
  });

  it('retains a simple vertical table merge across two rows', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1\trowd\clvmgf\cellx1000 Vertical\cell\cellx2000 A\cell\row\trowd\clvmrg\cellx1000\cell\cellx2000 B\cell\row}`,
    );
    expect(doc.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [[{ text: 'Vertical', rowSpan: 2 }, { text: 'A' }], [{ text: 'B' }]],
    });
  });

  it('uses the declared code page for hex bytes and per-font charset', async () => {
    const { doc } = await parse(
      String.raw`{\rtf1\ansi\ansicpg932{\fonttbl{\f0\fnil\fcharset128 MS Gothic;}}\f0\'82\'a0\par}`,
    );
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'あ' });
    expect(doc.encoding).toBe('shift_jis');
  });

  it('recognizes the common RTF code-page families and legacy charset selectors', async () => {
    const pages = [
      932, 936, 949, 950, 65001, 1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258, 874, 437, 850,
    ];
    const controls = pages.map((codePage) => `\\ansicpg${codePage} ASCII`).join(String.raw`\par`);
    const { doc, warnings } = await parse(`{\\rtf1\\ansi${controls}\\par}`);
    expect(doc.blocks).toHaveLength(pages.length);
    expect(doc.blocks.every((block) => block.kind === 'paragraph' && block.text === 'ASCII')).toBe(true);
    expect(doc.encoding).toBe('windows-1252');
    expect(warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');

    const legacy = await parse(String.raw`{\rtf1\mac Mac\par\pc DOS\par}`);
    expect(legacy.doc.blocks).toMatchObject([
      { kind: 'paragraph', text: 'Mac' },
      { kind: 'paragraph', text: 'DOS' },
    ]);
    expect(legacy.doc.encoding).toBe('windows-1252');
    expect(legacy.warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });

  it('applies RTF font charsets and falls back for unknown charset identifiers', async () => {
    const fontTable = String.raw`{\fonttbl{\f0\fcharset128 Japan;}{\f1\fcharset134 China;}{\f2\fcharset129 Korea;}{\f3\fcharset136 Taiwan;}{\f4\fcharset204 Cyrillic;}{\f5\fcharset238 Central;}{\f6\fcharset177 Hebrew;}{\f7\fcharset178 Arabic;}{\f8\fcharset163 Vietnamese;}{\f9\fcharset186 Baltic;}{\f10\fcharset222 Thai;}{\f11\fcharset77 Mac;}{\f12\fcharset2 Symbol;}{\f13\fcharset99 Unknown;}}`;
    const body = Array.from({ length: 14 }, (_, font) => `\\f${font} F${font}\\par`).join('');
    const { doc, warnings } = await parse(`{\\rtf1\\ansi${fontTable}${body}}`);
    expect(doc.blocks).toHaveLength(14);
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'F0' });
    expect(doc.blocks[13]).toMatchObject({ kind: 'paragraph', text: 'F13' });
    expect(warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });

  it('skips binary payloads by available byte length and flags embedded objects', async () => {
    const { doc, warnings } = await parse(
      String.raw`{\rtf1 Before {\*\unknown hidden} after {\object\objdata 0000}\bin999999999 ` +
        'xyz' +
        String.raw`}`,
    );
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Before  after' });
    expect(doc.features.hasEmbeddedFiles).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(warnings)).not.toContain('xyz');
  });

  it('bounds deeply nested groups and safely returns text before an unterminated group', async () => {
    const deep = `{\\rtf1 before ${'{'.repeat(100_000)}too deep${'}'.repeat(100_000)} after`;
    const nested = await parse(deep, { blockDepth: 12 });
    expect(JSON.stringify(nested.doc)).toContain('before');
    expect(nested.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
    const malformed = await parse('{\\rtf1 readable\\par {\\b unfinished');
    expect(malformed.doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'readable' });
    expect(malformed.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expectBlockDepthAvailable(malformed.budget, malformed.budget.limits.blockDepth);
  });

  it('skips control words, escaped braces and binary payloads inside an over-depth group', async () => {
    const prefix = new TextEncoder().encode(String.raw`{\rtf1 keep ${'{'.repeat(3)}\b\bin4 `);
    const suffix = new TextEncoder().encode(String.raw`\'e9\{\}\\skip\unknown-12 ${'}'.repeat(4)}`);
    const bytes = new Uint8Array(prefix.length + 4 + suffix.length);
    bytes.set(prefix);
    bytes.set([123, 125, 92, 123], prefix.length);
    bytes.set(suffix, prefix.length + 4);
    const { doc, warnings, budget } = await parse(bytes, { blockDepth: 2 });
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'keep' });
    expect(warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
    expect(warnings.map(({ code }) => code)).not.toContain('UNREADABLE_PART');
    expectBlockDepthAvailable(budget, budget.limits.blockDepth);
  });

  it('stops when the shared output budget is exhausted without exposing source text', async () => {
    const { doc, warnings } = await parse(String.raw`{\rtf1 first\par secret second\par}`, {
      outputChars: 7,
    });
    expect(doc.blocks).toMatchObject([{ kind: 'paragraph', text: 'first' }]);
    expect(doc.stats.truncated).toBe(true);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(JSON.stringify(warnings)).not.toContain('secret');
  });

  it('checks cancellation through the shared budget on the parser loop', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parse(String.raw`{\rtf1 text}`, {}, controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });

  it('balances attempted depth entries when the depth limit throws', async () => {
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits({ blockDepth: 2 }), { warnings, onLimit: 'throw' });
    const options = { limits: budget.limits, runs: false } as ResolvedOptions;
    const out = new DocBuilder('rtf', 'application/rtf', budget, options);
    const ctx = {
      bytes: new TextEncoder().encode(String.raw`{\rtf1{{deeper}}}`),
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    await expect((async () => reader.read(ctx))()).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expectBlockDepthAvailable(budget, budget.limits.blockDepth);
  });

  it('balances group depth when output truncation stops parsing inside nested groups', async () => {
    const truncated = await parse(String.raw`{\rtf1{first\par second}}`, { outputChars: 2 });
    expect(truncated.doc.stats.truncated).toBe(true);
    expectBlockDepthAvailable(truncated.budget, truncated.budget.limits.blockDepth);
  });

  it('balances group depth when abort occurs after a block is emitted', async () => {
    const controller = new AbortController();
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits({ blockDepth: 4 }), { warnings, signal: controller.signal });
    const options: ResolvedOptions = {
      limits: budget.limits,
      runs: false,
      onLimit: 'truncate',
      strict: false,
      metadata: true,
      children: 'extract',
      childBytes: false,
      revisions: 'accept',
      includeHidden: false,
      formulas: false,
      onBlock: () => controller.abort(),
    };
    const out = new DocBuilder('rtf', 'application/rtf', budget, options);
    const ctx = {
      bytes: new TextEncoder().encode(String.raw`{\rtf1 outer\par rest}`),
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    await expect((async () => reader.read(ctx))()).rejects.toMatchObject({ code: 'ABORTED' });
    expectBlockDepthAvailable(budget, budget.limits.blockDepth);
  });

  it('runs the bounded fuzz entry point on arbitrary and malformed bytes', async () => {
    await fuzzRtf(new Uint8Array([0, 123, 92, 114, 116, 102, 49, 125, 255]));
    await fuzzRtf(new TextEncoder().encode(String.raw`{\rtf1{\bin999999999 x}}`));
  });
});

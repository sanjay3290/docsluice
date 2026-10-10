import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { extract } from '../../src/core/extract.js';
import { toText } from '../../src/render/text.js';
import type { ListItem } from '../../src/core/model.js';
import {
  formatNumber,
  listMarker,
  NumberingCounters,
  parseDocxNumbering,
} from '../../src/readers/docx/numbering.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const context = () => {
  const warnings = new WarningSink();
  return { budget: new Budget(DEFAULT_LIMITS, { warnings }), warnings };
};
const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../corpus/docx/${name}`, import.meta.url)));

function markers(items: readonly ListItem[], depth = 0): string[] {
  return items.flatMap((item) => [
    `${'  '.repeat(depth)}${item.marker ?? ''} ${item.text}`,
    ...markers(item.items ?? [], depth + 1),
  ]);
}

describe('DOCX numbering formats', () => {
  it.each([
    [1, 'decimal', '1'],
    [7, 'decimalZero', '07'],
    [12, 'decimalZero', '12'],
    [1, 'lowerLetter', 'a'],
    [26, 'lowerLetter', 'z'],
    [27, 'lowerLetter', 'aa'],
    [28, 'upperLetter', 'BB'],
    [4, 'lowerRoman', 'iv'],
    [1999, 'upperRoman', 'MCMXCIX'],
    [1, 'ordinal', '1st'],
    [2, 'ordinal', '2nd'],
    [3, 'ordinal', '3rd'],
    [11, 'ordinal', '11th'],
    [22, 'ordinal', '22nd'],
    [113, 'ordinal', '113th'],
    [5, 'none', ''],
    [5, 'bullet', ''],
    [5, 'chineseCounting', '5'],
    [0, 'lowerRoman', '0'],
  ])('formats %i as %s → %j', (value, format, expected) => {
    expect(formatNumber(value, format)).toBe(expected);
  });
});

describe('DOCX numbering definitions', () => {
  const xml = `<w:numbering xmlns:w="${W}">
    <w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
      <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2"/><w:lvlRestart w:val="0"/></w:lvl>
      <w:lvl w:ilvl="2"><w:numFmt w:val="bullet"/><w:lvlText w:val="&#xF0B7;"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="7"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="10"/></w:lvlOverride>
      <w:lvlOverride w:ilvl="2"><w:lvl w:ilvl="2"><w:numFmt w:val="upperRoman"/><w:lvlText w:val="(%3)"/></w:lvl></w:lvlOverride></w:num>
    <w:num w:numId="__proto__"><w:abstractNumId w:val="missing"/></w:num>
  </w:numbering>`;

  it('merges abstract levels with instance overrides and ignores unknown abstracts', () => {
    const numbering = parseDocxNumbering(xml, context());
    expect([...numbering.keys()]).toEqual(['1', '2']);
    expect(numbering.get('1')!.levels.get(0)).toEqual({ numFmt: 'decimal', lvlText: '%1.', start: 3 });
    expect(numbering.get('1')!.levels.get(1)).toEqual({
      numFmt: 'lowerLetter',
      lvlText: '%1.%2',
      start: 1,
      restart: 0,
    });
    expect(numbering.get('2')!.startOverrides.get(0)).toBe(10);
    expect(numbering.get('2')!.levels.get(2)).toEqual({ numFmt: 'upperRoman', lvlText: '(%3)', start: 1 });
    expect(({} as Record<string, unknown>).abstractNumId).toBeUndefined();
  });

  it('cuts level text at 255 characters so markers stay small', () => {
    const numbering = parseDocxNumbering(
      `<w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:lvlText w:val="${'%1'.repeat(1000)}"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
      context(),
    );
    expect(numbering.get('1')!.levels.get(0)!.lvlText).toHaveLength(255);
  });

  it('composes parent counters, maps symbol bullets and honours start overrides and lvlRestart 0', () => {
    const ctx = context();
    const numbering = parseDocxNumbering(xml, ctx);
    const counters = new NumberingCounters();
    const one = numbering.get('1')!;
    const sequence = [0, 1, 1, 2, 0, 1].map((ilvl) =>
      listMarker(one.levels, counters.next('1', one, ilvl, ctx.budget), ilvl, ctx.budget),
    );
    // lvlRestart 0 keeps level 1 counting across a new level-0 item: c is not reset to a.
    expect(sequence).toEqual(['3.', '3.a', '3.b', '•', '4.', '4.c']);
    const two = numbering.get('2')!;
    expect(listMarker(two.levels, counters.next('2', two, 0, ctx.budget), 0, ctx.budget)).toBe('10.');
    expect(listMarker(two.levels, counters.next('2', two, 2, ctx.budget), 2, ctx.budget)).toBe('(I)');
  });
});

describe('DOCX list blocks', () => {
  it('builds nested list blocks with visible markers from the numbering corpus file', async () => {
    const doc = await extract(corpus('numbering.docx'), { filename: 'numbering.docx' });
    const lists = doc.blocks.filter((block) => block.kind === 'list');
    expect(lists.map((block) => markers(block.items))).toEqual([
      [
        '1. Scope',
        '  1.1. Definitions',
        '    1.1.1. Terms',
        '    1.1.2. Abbreviations',
        '  1.2. Interpretation',
        '2. Obligations',
        '  2.1. Payment',
      ],
      ['3. Termination'],
      ['1. First again', '2. Second again'],
      ['a) Alpha', '  i. Detail one', '  ii. Detail two', '    I. Deep point', 'b) Beta'],
      ['• Round', '  o Hollow', '    ▪ Square'],
      ['1. Step one', '  • Note under step one', '    01) Sub-step', '2. Step two'],
      ['(D) Fourth letter', '(E) Fifth letter'],
      ['• Styled item one', '• Styled item two'],
      ['1st Ordinal under the heading', '2nd Second ordinal'],
    ]);
    expect(lists.map((block) => block.kind === 'list' && block.ordered)).toEqual([
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(
      doc.blocks.some(
        (block) => block.kind === 'heading' && block.text === 'Numbered heading keeps its level',
      ),
    ).toBe(true);
    expect(toText(doc)).toContain('1.1.1. Terms');
  });

  it('flattens lists deeper than blockDepth with DEPTH_LIMIT', async () => {
    const doc = await extract(corpus('numbering.docx'), {
      filename: 'numbering.docx',
      limits: { blockDepth: 2 },
    });
    const legal = doc.blocks.find((block) => block.kind === 'list');
    expect(legal?.kind === 'list' && markers(legal.items)).toContain('  1.1.1. Terms');
    expect(doc.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });
});

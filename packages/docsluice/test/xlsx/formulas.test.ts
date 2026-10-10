import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Block, Cell, DocsluiceDocument } from '../../src/core/model.js';
import { toJSON } from '../../src/render/json.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { shiftFormula } from '../../src/readers/xlsx/formula.js';

const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const corpus = new URL('../../../../corpus/xlsx/', import.meta.url);
const fixture = () => new Uint8Array(readFileSync(new URL('formulas.xlsx', corpus)));

function firstRows(doc: DocsluiceDocument): Cell[][] {
  const section = doc.blocks[0] as Extract<Block, { kind: 'section' }>;
  return (section.blocks[0] as Extract<Block, { kind: 'table' }>).rows;
}

describe('XLSX formulas (XLS-4)', () => {
  // The default (no formula text) is covered by the golden runner; formulas: true uses sidecars.
  it('matches the reviewed output with formulas: true', async () => {
    const doc = await extract(fixture(), { filename: 'formulas.xlsx', formulas: true });
    doc.stats.durationMs = 0;
    const json = toJSON(doc, { stable: true });
    const markdown = toMarkdown(doc);
    const jsonPath = new URL('formulas.xlsx.formulas.expected.json', corpus);
    const markdownPath = new URL('formulas.xlsx.formulas.expected.md', corpus);
    if (update) {
      writeFileSync(jsonPath, json);
      writeFileSync(markdownPath, markdown);
      return;
    }
    expect(existsSync(jsonPath)).toBe(true);
    expect(json).toBe(readFileSync(jsonPath, 'utf8'));
    expect(markdown).toBe(readFileSync(markdownPath, 'utf8'));
  });

  it('shows the cached value and never evaluates: =1+1 cached as 5 gives 5', async () => {
    for (const formulas of [false, true]) {
      const rows = firstRows(await extract(fixture(), { formulas }));
      expect(rows[0]![3]).toEqual(
        formulas
          ? { text: '5', raw: 5, formula: '=1+1', address: 'D1' }
          : { text: '5', raw: 5, address: 'D1' },
      );
    }
  });

  it('keeps formula text only with formulas: true', async () => {
    const plain = await extract(fixture());
    expect(JSON.stringify(plain.blocks)).not.toContain('"formula"');
    const rows = firstRows(await extract(fixture(), { formulas: true }));
    expect(rows.map((row) => row.map((cell) => cell.formula ?? ''))).toEqual([
      ['', '', '=A1+B1', '=1+1', '{=ROW(A1:A3)*2}', "=Other!A1+'My Sheet'!B2", '=A1*10', '="A1="&A1'],
      ['', '', '=A2*$B$1+LOG10(B2)', '', '', '', '', ''],
      ['', '', '=A3*$B$1+LOG10(B3)', '', '', '', '', ''],
      ['', '', '=A4*$B$1+LOG10(B4)', '', '', '', '', ''],
      ['', '', '', '', '', '', '', ''],
      ['=A5+1', '=B5+1', '=C5+1', '', '', '', '', ''],
    ]);
  });

  it('leaves a formula without a cached value empty with one warning per sheet', async () => {
    const doc = await extract(fixture());
    expect(firstRows(doc)[0]![6]).toEqual({ text: '', address: 'G1' });
    expect(doc.warnings).toEqual([
      {
        code: 'UNREADABLE_PART',
        message:
          'Sheet 1: 1 formula cells have no cached value and are empty; formulas are never calculated.',
        loc: { path: 'xl/worksheets/sheet1.xml' },
      },
    ]);
  });
});

describe('shiftFormula', () => {
  const budget = () => new Budget(DEFAULT_LIMITS);

  it.each([
    ['A1+B1', 1, 0, 'A2+B2'],
    ['A1+B1', 0, 2, 'C1+D1'],
    ['$A$1+$A1+A$1', 3, 3, '$A$1+$A4+D$1'],
    ['SUM(A1:B2)', 1, 1, 'SUM(B2:C3)'],
    ['LOG10(A1)+ATAN2(A1,B1)', 1, 0, 'LOG10(A2)+ATAN2(A2,B2)'],
    ['Q1!A1+Sheet1!B2', 1, 0, 'Q1!A2+Sheet1!B3'],
    ['\'A1 sheet\'!A1&"A1"&"say ""B2"""', 1, 0, '\'A1 sheet\'!A2&"A1"&"say ""B2"""'],
    ['A:A+1:1', 1, 1, 'A:A+1:1'],
    ['TRUE+1E5+2.5+ABCD1', 1, 1, 'TRUE+1E5+2.5+ABCD1'],
    ['A1', -1, 0, '#REF!'],
    ['XFD1', 0, 1, '#REF!'],
    ['__proto__+constructor', 1, 1, '__proto__+constructor'],
    ['"unterminated A1', 1, 0, '"unterminated A1'],
  ])('shifts %s by (%i, %i)', (formula, rows, columns, expected) => {
    expect(shiftFormula(formula, rows, columns, budget())).toBe(expected);
  });
});

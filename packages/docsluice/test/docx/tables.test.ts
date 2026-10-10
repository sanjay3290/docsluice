import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Limits } from '../../src/core/limits.js';
import type { ResolvedOptions } from '../../src/core/options.js';
import { WarningSink } from '../../src/core/warnings.js';
import { scanDocxBody } from '../../src/readers/docx/body.js';
import type { Block } from '../../src/core/model.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const p = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const tc = (content: string, props = '') =>
  `<w:tc>${props ? `<w:tcPr>${props}</w:tcPr>` : ''}${content}</w:tc>`;
const tr = (cells: string, header = false) =>
  `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells}</w:tr>`;
const tbl = (rows: string) => `<w:tbl>${rows}</w:tbl>`;

function scan(body: string, limits: Partial<Limits> = {}) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  const options = { runs: false, limits: budget.limits } as ResolvedOptions;
  const out = new DocBuilder('docx', 'application/docx', budget, options);
  scanDocxBody(
    `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
    { budget, warnings, options, out },
    new Map(),
    new Map(),
  );
  return { doc: out.finish(), warnings: warnings.warnings, budget };
}

const texts = (block: Block | undefined) =>
  block?.kind === 'table' ? block.rows.map((row) => row.map((cell) => cell.text)) : undefined;

describe('DOCX tables', () => {
  it('maps gridSpan to colSpan with placeholder cells on the grid', () => {
    const { doc } = scan(
      tbl(tr(tc(p('AB'), '<w:gridSpan w:val="2"/>') + tc(p('C'))) + tr(tc(p('a')) + tc(p('b')) + tc(p('c')))),
    );
    const table = doc.blocks[0];
    expect(table).toMatchObject({
      kind: 'table',
      headerRows: 0,
      rows: [
        [{ text: 'AB', colSpan: 2 }, { text: '' }, { text: 'C' }],
        [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      ],
    });
  });

  it('maps vMerge restart and continue to rowSpan', () => {
    const { doc } = scan(
      tbl(
        tr(tc(p('Tall'), '<w:vMerge w:val="restart"/>') + tc(p('one'))) +
          tr(tc(p(''), '<w:vMerge/>') + tc(p('two'))) +
          tr(tc(p(''), '<w:vMerge w:val="continue"/>') + tc(p('three'))) +
          tr(tc(p('Next')) + tc(p('four'))),
      ),
    );
    expect(doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'Tall', rowSpan: 3 }, { text: 'one' }],
        [{ text: '' }, { text: 'two' }],
        [{ text: '' }, { text: 'three' }],
        [{ text: 'Next' }, { text: 'four' }],
      ],
    });
    expect(doc.blocks[0]?.kind === 'table' && doc.blocks[0].rows[3]![0]).not.toHaveProperty('rowSpan');
  });

  it('combines horizontal and vertical merges in one block', () => {
    const { doc } = scan(
      tbl(
        tr(tc(p('Block'), '<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>') + tc(p('x'))) +
          tr(tc(p(''), '<w:gridSpan w:val="2"/><w:vMerge/>') + tc(p('y'))),
      ),
    );
    expect(doc.blocks[0]).toMatchObject({
      rows: [
        [{ text: 'Block', colSpan: 2, rowSpan: 2 }, { text: '' }, { text: 'x' }],
        [{ text: '' }, { text: '' }, { text: 'y' }],
      ],
    });
  });

  it('clamps gridSpan at 64 columns', () => {
    const { doc } = scan(tbl(tr(tc(p('wide'), '<w:gridSpan w:val="100000"/>'))));
    expect(doc.blocks[0]?.kind === 'table' && doc.blocks[0].rows[0]).toHaveLength(64);
    expect(doc.blocks[0]?.kind === 'table' && doc.blocks[0].rows[0]![0]).toEqual({
      text: 'wide',
      colSpan: 64,
    });
  });

  it('counts leading tblHeader rows only', () => {
    const { doc } = scan(
      tbl(tr(tc(p('H1')), true) + tr(tc(p('H2')), true) + tr(tc(p('body'))) + tr(tc(p('late')), true)),
    );
    expect(doc.blocks[0]).toMatchObject({ kind: 'table', headerRows: 2 });
  });

  it('joins a cell’s paragraphs with line breaks and keeps paragraphs around the table in order', () => {
    const { doc } = scan(p('before') + tbl(tr(tc(p('first') + p('second')))) + p('after'));
    expect(doc.blocks.map((block) => block.kind)).toEqual(['paragraph', 'table', 'paragraph']);
    expect(texts(doc.blocks[1])).toEqual([['first\nsecond']]);
  });

  it('emits nested tables after their parent and keeps their flattened text in the parent cell', () => {
    const inner2 = tbl(tr(tc(p('deepest'))));
    const inner1 = tbl(tr(tc(p('inner') + inner2) + tc(p('side'))));
    const { doc } = scan(tbl(tr(tc(p('outer') + inner1) + tc(p('right')))) + p('end'));
    expect(doc.blocks.map((block) => block.kind)).toEqual(['table', 'table', 'table', 'paragraph']);
    expect(texts(doc.blocks[0])).toEqual([['outer\ninner\ndeepest\tside', 'right']]);
    expect(texts(doc.blocks[1])).toEqual([['inner\ndeepest', 'side']]);
    expect(texts(doc.blocks[2])).toEqual([['deepest']]);
  });

  it('stops adding cells at the shared cell budget', () => {
    const { doc, budget } = scan(tbl(tr(tc(p('a')) + tc(p('b'))) + tr(tc(p('c')) + tc(p('d')))), {
      cells: 3,
    });
    expect(texts(doc.blocks[0])!.flat().length).toBeLessThanOrEqual(3);
    expect(budget.truncated).toBe(true);
  });

  it('flattens tables nested past blockDepth with DEPTH_LIMIT and keeps their text', () => {
    const nested = `${'<w:tbl><w:tr><w:tc>'.repeat(1_000)}${p('core')}${'</w:tc></w:tr></w:tbl>'.repeat(1_000)}`;
    const shallow = scan(
      `${'<w:tbl><w:tr><w:tc>'.repeat(20)}${p('core')}${'</w:tc></w:tr></w:tbl>'.repeat(20)}`,
      { blockDepth: 8 },
    );
    expect(shallow.warnings.map(({ code }) => code)).toEqual(['DEPTH_LIMIT']);
    expect(shallow.doc.blocks.filter((block) => block.kind === 'table')).toHaveLength(8);
    expect(texts(shallow.doc.blocks.at(-1))).toEqual([['core']]);
    const deep = scan(nested, { blockDepth: 8 });
    expect(deep.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });
});

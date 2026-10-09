import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { parseXml } from '../../../src/xml/index.js';
import { createTextStage, parseTextBody, toListItems } from '../../../src/readers/pptx/text.js';

const NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function parseBody(xml: string) {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(), { warnings });
  const root = parseXml(new TextEncoder().encode(xml), { budget, warnings });
  if (!root) throw new Error('Test XML did not produce a root element.');
  return { paragraphs: parseTextBody(root, budget), budget };
}

describe('PPTX text bodies', () => {
  it('retains explicit bullet levels as a nested list', () => {
    const { paragraphs, budget } = parseBody(
      `<a:txBody xmlns:a="${NS}"><a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr><a:r><a:t>Parent</a:t></a:r></a:p><a:p><a:pPr lvl="1"><a:buChar char="•"/></a:pPr><a:r><a:t>Child</a:t></a:r></a:p></a:txBody>`,
    );
    expect(paragraphs).toMatchObject([
      { text: 'Parent', level: 0, bullet: true, ordered: false },
      { text: 'Child', level: 1, bullet: true, ordered: false },
    ]);
    expect(toListItems(paragraphs, budget)).toEqual([
      { text: 'Parent', marker: '•', items: [{ text: 'Child', marker: '•' }] },
    ]);
  });

  it('ignores XML indentation outside a:t and joins run text', () => {
    const { paragraphs } = parseBody(
      `<a:txBody xmlns:a="${NS}">\n<a:p>\n<a:r><a:t>One</a:t></a:r><a:r><a:t> two</a:t></a:r>\n</a:p>\n</a:txBody>`,
    );
    expect(paragraphs).toEqual([{ text: 'One two', level: 0, bullet: false, ordered: false }]);
  });

  it('reads text only from paragraph runs and fields, ignoring extension payloads', () => {
    const { paragraphs } = parseBody(
      `<a:txBody xmlns:a="${NS}"><a:p><a:r><a:t>Visible</a:t></a:r><a:extLst><a:ext><a:r><a:t>Injected extension text</a:t></a:r></a:ext></a:extLst></a:p></a:txBody>`,
    );
    expect(paragraphs).toEqual([{ text: 'Visible', level: 0, bullet: false, ordered: false }]);
  });

  it('preflights cumulative text before retaining repeated body/table-cell paragraphs', () => {
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits({ outputChars: 5 }), { warnings });
    const stage = createTextStage();
    const xml = `<a:txBody xmlns:a="${NS}"><a:p><a:r><a:t>abc</a:t></a:r></a:p></a:txBody>`;
    const first = parseXml(new TextEncoder().encode(xml), { budget, warnings });
    const second = parseXml(new TextEncoder().encode(xml), { budget, warnings });
    expect(first && parseTextBody(first, budget, stage)).toHaveLength(1);
    expect(second && parseTextBody(second, budget, stage)).toEqual([]);
    expect(stage.pendingChars).toBe(3);
    expect(stage.blocked).toBe(true);
    expect(budget.truncated).toBe(true);
  });
});

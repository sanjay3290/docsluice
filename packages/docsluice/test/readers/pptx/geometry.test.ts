import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { parseXml } from '../../../src/xml/index.js';
import { applyTransform, groupTransform, shapePosition } from '../../../src/readers/pptx/geometry.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function xmlElement(xml: string) {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(), { warnings });
  const element = parseXml(new TextEncoder().encode(xml), { budget, warnings });
  if (!element) throw new Error('Test XML did not produce a root element.');
  return { element, budget };
}

describe('PPTX geometry', () => {
  it('composes nested group transforms before positioning a child shape', () => {
    const outer = xmlElement(
      `<p:grpSp xmlns:p="${P}" xmlns:a="${A}"><p:grpSpPr><a:xfrm><a:off x="100" y="200"/><a:ext cx="400" cy="300"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr></p:grpSp>`,
    );
    const inner = xmlElement(
      `<p:grpSp xmlns:p="${P}" xmlns:a="${A}"><p:grpSpPr><a:xfrm><a:off x="10" y="20"/><a:ext cx="50" cy="50"/><a:chOff x="0" y="0"/><a:chExt cx="100" cy="100"/></a:xfrm></p:grpSpPr></p:grpSp>`,
    );
    const shape = xmlElement(
      `<p:sp xmlns:p="${P}" xmlns:a="${A}"><p:spPr><a:xfrm><a:off x="10" y="10"/><a:ext cx="10" cy="10"/></a:xfrm></p:spPr></p:sp>`,
    );
    const first = groupTransform(outer.element, { sx: 1, sy: 1, tx: 0, ty: 0 }, outer.budget);
    const second = groupTransform(inner.element, first, inner.budget);
    const point = shapePosition(shape.element, shape.budget);
    expect(point).toEqual({ x: 10, y: 10 });
    expect(point && applyTransform(point, second)).toEqual({ x: 160, y: 275 });
  });

  it('drops a transformed point if hostile coordinates overflow', () => {
    expect(applyTransform({ x: Number.MAX_VALUE, y: 0 }, { sx: 4, sy: 1, tx: 0, ty: 0 })).toBeUndefined();
  });
});

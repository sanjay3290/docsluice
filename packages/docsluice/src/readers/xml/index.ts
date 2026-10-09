import type { ReadContext, Reader } from '../../core/reader.js';
import { parseXml, type XmlElement } from '../../xml/index.js';

interface XmlWalkFrame {
  element: XmlElement;
  path: string;
}

function directText(element: XmlElement, ctx: ReadContext): string {
  const pieces: string[] = [];
  for (const child of element.children) {
    ctx.budget.tick();
    if (typeof child === 'string') pieces.push(child);
  }
  return pieces.join('').trim();
}

function childCounts(
  element: XmlElement,
  ctx: ReadContext,
): {
  counts: Map<string, number>;
  elements: Array<{ element: XmlElement; occurrence: number }>;
} {
  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  const elements: Array<{ element: XmlElement; occurrence: number }> = [];
  for (const child of element.children) {
    ctx.budget.tick();
    if (typeof child !== 'string') {
      const occurrence = (seen.get(child.localName) ?? 0) + 1;
      seen.set(child.localName, occurrence);
      counts.set(child.localName, occurrence);
      elements.push({ element: child, occurrence });
    }
  }
  return { counts, elements };
}

/** Generic XML reader over the shared safe XML parser; attributes and DTD content are ignored. */
export const reader: Reader = {
  id: 'xml',
  mimeTypes: ['application/xml', 'text/xml'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    await Promise.resolve();
    const root = parseXml(ctx.bytes, { budget: ctx.budget, warnings: ctx.warnings, path: ctx.path });
    if (!root) {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'XML document has no root element.' });
      return;
    }

    const stack: XmlWalkFrame[] = [{ element: root, path: `/${root.localName}` }];
    while (stack.length > 0) {
      ctx.budget.tick();
      const frame = stack.pop()!;
      const text = directText(frame.element, ctx);
      const path = ctx.path ? `${ctx.path}#${frame.path}` : frame.path;
      if (text && !ctx.out.paragraph(text, { path })) return;

      const { counts, elements } = childCounts(frame.element, ctx);
      for (let index = elements.length - 1; index >= 0; index -= 1) {
        ctx.budget.tick();
        const entry = elements[index]!;
        const suffix = (counts.get(entry.element.localName) ?? 0) > 1 ? `[${entry.occurrence}]` : '';
        stack.push({ element: entry.element, path: `${frame.path}/${entry.element.localName}${suffix}` });
      }
    }
  },
};

export default reader;

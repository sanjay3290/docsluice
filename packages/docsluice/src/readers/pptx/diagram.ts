import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { A_NS, DGM_NS } from './presentationml.js';

/** SmartArt nesting deeper than this is shown at this level. */
const MAX_LEVEL = 8;
/** Point types that carry no visible text of their own (ECMA-376 Part 1, 21.4.7.51). */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(['doc', 'pres', 'parTrans', 'sibTrans']);

export interface DiagramItem {
  text: string;
  level: number;
}

/**
 * Text of a SmartArt data part (`dgm:dataModel`): each node point's `dgm:t` paragraphs, in data
 * order, with its level from the `parOf` connections (children of the document root are level 0).
 */
export function parseDiagramData(input: Uint8Array, ctx: XmlContext): DiagramItem[] {
  const points: Array<{ id: string; text: string }> = [];
  const parents = new Map<string, string>();
  const rootIds = new Set<string>();
  const names: Array<string | undefined> = [];
  let point: { id: string; text: string; paragraphs: string[]; keep: boolean } | undefined;
  let paragraph: string | undefined;
  let textDepth = 0;

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        const local =
          info.namespaceURI === DGM_NS
            ? `dgm:${info.localName}`
            : info.namespaceURI === A_NS
              ? info.localName
              : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (local === 'dgm:pt' && parent === 'dgm:ptLst') {
          const type = attrs.get('type') ?? 'node';
          const id = attrs.get('modelId') ?? '';
          if (type === 'doc') rootIds.add(id);
          point = { id, text: '', paragraphs: [], keep: !SKIPPED_TYPES.has(type) };
        } else if (local === 'dgm:cxn' && parent === 'dgm:cxnLst') {
          const type = attrs.get('type') ?? 'parOf';
          const source = attrs.get('srcId');
          const destination = attrs.get('destId');
          if (
            type === 'parOf' &&
            source !== undefined &&
            destination !== undefined &&
            !parents.has(destination)
          ) {
            parents.set(destination, source);
          }
        } else if (point && local === 'p') {
          paragraph = '';
        } else if (point && paragraph !== undefined && local === 't') {
          textDepth++;
        }
      },
      onText(text) {
        if (textDepth > 0 && paragraph !== undefined) paragraph += text;
      },
      onClose() {
        ctx.budget.tick();
        const local = names.pop();
        if (local === 't' && textDepth > 0) textDepth--;
        else if (local === 'p' && point && paragraph !== undefined) {
          if (paragraph.length > 0) point.paragraphs.push(paragraph);
          paragraph = undefined;
        } else if (local === 'dgm:pt' && point) {
          if (point.keep && point.paragraphs.length > 0) {
            points.push({ id: point.id, text: point.paragraphs.join('\n') });
          }
          point = undefined;
        }
      },
    },
    ctx,
  );

  const items: DiagramItem[] = [];
  for (const { id, text } of points) {
    ctx.budget.tick();
    // Walk up the parOf chain with a bounded loop; cycles and long chains stop at MAX_LEVEL.
    let level = -1;
    let cursor: string | undefined = id;
    while (cursor !== undefined && !rootIds.has(cursor) && level < MAX_LEVEL) {
      ctx.budget.tick();
      level++;
      cursor = parents.get(cursor);
    }
    items.push({ text, level: Math.max(0, level) });
  }
  return items;
}

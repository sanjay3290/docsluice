import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import type { XlsxNamedRange } from './emit.js';
import { parseIndex, parseRangeReference, SHEET_NAMESPACES } from './spreadsheetml.js';

/**
 * An Excel table part (ListObject, ECMA-376 Part 1, 18.5): its `displayName` (else `name`), its
 * `ref` range and `headerRowCount` (1 when absent). Only the root element is read.
 */
export function parseTablePart(input: Uint8Array, ctx: XmlContext): XlsxNamedRange | undefined {
  let result: XlsxNamedRange | undefined;
  let depth = 0;
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        depth++;
        if (depth !== 1 || info.localName !== 'table' || !SHEET_NAMESPACES.has(info.namespaceURI ?? ''))
          return;
        const name = attrs.get('displayName') ?? attrs.get('name');
        const range = parseRangeReference(attrs.get('ref'));
        if (name === undefined || name.length === 0 || !range) return;
        result = { name, range, headerRows: parseIndex(attrs.get('headerRowCount'), 1_000) ?? 1 };
      },
      onClose() {
        ctx.budget.tick();
        depth--;
      },
    },
    ctx,
  );
  return result;
}

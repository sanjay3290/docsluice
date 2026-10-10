import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import {
  namespacedAttribute,
  namespaceScope,
  RELATIONSHIP_NAMESPACES,
  SHEET_NAMESPACES,
} from './spreadsheetml.js';

/** One `sheets/sheet` entry of `workbook.xml` (ECMA-376 Part 1, 18.2.19). */
export interface XlsxSheetEntry {
  name?: string;
  /** `hidden` or `veryHidden`; visible sheets have no state. */
  hidden?: true | 'very';
  relationshipId?: string;
}

export interface XlsxWorkbook {
  /** Sheets in workbook order; this order is the output order (XLS-1). */
  sheets: XlsxSheetEntry[];
  date1904: boolean;
}

/** Parse the workbook part with bounded SAX events. */
export function parseWorkbook(input: Uint8Array, ctx: XmlContext): XlsxWorkbook {
  const workbook: XlsxWorkbook = { sheets: [], date1904: false };
  const names: Array<string | undefined> = [];
  const scopes: Map<string, string>[] = [];
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        scopes.push(namespaceScope(attrs, ctx.budget));
        const local =
          info.namespaceURI !== undefined && SHEET_NAMESPACES.has(info.namespaceURI)
            ? info.localName
            : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (local === 'sheet' && parent === 'sheets' && names.length === 3) {
          const entry: XlsxSheetEntry = {};
          const name = attrs.get('name');
          if (name !== undefined) entry.name = name;
          const state = attrs.get('state');
          if (state === 'hidden') entry.hidden = true;
          else if (state === 'veryHidden') entry.hidden = 'very';
          const id = namespacedAttribute(attrs, 'id', RELATIONSHIP_NAMESPACES, scopes, ctx.budget);
          if (id !== undefined) entry.relationshipId = id;
          workbook.sheets.push(entry);
        } else if (local === 'workbookPr' && names.length === 2) {
          const value = attrs.get('date1904');
          workbook.date1904 = value === '1' || value === 'true';
        }
      },
      onClose() {
        ctx.budget.tick();
        names.pop();
        scopes.pop();
      },
    },
    ctx,
  );
  return workbook;
}

import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import type { XlsxRange } from './sheet.js';
import {
  namespacedAttribute,
  parseRangeReference,
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

/** A visible `definedNames/definedName` that refers to one range of one sheet (XLS-9). */
export interface XlsxDefinedName {
  name: string;
  sheet: string;
  range: XlsxRange;
}

export interface XlsxWorkbook {
  /** Sheets in workbook order; this order is the output order (XLS-1). */
  sheets: XlsxSheetEntry[];
  date1904: boolean;
  /** Defined names in workbook order. Built-in (`_xlnm.`), hidden and formula names are left out. */
  definedNames: XlsxDefinedName[];
}

/** Longer defined-name formulas are not single ranges and are not read. */
const MAX_NAME_FORMULA = 512;

/** Parse the workbook part with bounded SAX events. */
export function parseWorkbook(input: Uint8Array, ctx: XmlContext): XlsxWorkbook {
  const workbook: XlsxWorkbook = { sheets: [], date1904: false, definedNames: [] };
  let definedName: { name: string; text: string; long?: boolean } | undefined;
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
        } else if (local === 'definedName' && parent === 'definedNames' && names.length === 3) {
          const name = attrs.get('name');
          const hidden = attrs.get('hidden');
          if (name !== undefined && !name.startsWith('_xlnm.') && hidden !== '1' && hidden !== 'true')
            definedName = { name, text: '' };
        } else if (local === 'workbookPr' && names.length === 2) {
          const value = attrs.get('date1904');
          workbook.date1904 = value === '1' || value === 'true';
        }
      },
      onText(text) {
        if (!definedName) return;
        if (definedName.text.length + text.length > MAX_NAME_FORMULA) definedName.long = true;
        else definedName.text += text;
      },
      onClose() {
        ctx.budget.tick();
        if (names.pop() === 'definedName' && definedName) {
          const reference = definedName.long ? undefined : parseSheetRange(definedName.text, ctx.budget);
          if (reference) workbook.definedNames.push({ name: definedName.name, ...reference });
          definedName = undefined;
        }
        scopes.pop();
      },
    },
    ctx,
  );
  return workbook;
}

/**
 * A defined-name formula that is exactly one range of one sheet: `Sheet1!$A$1:$C$4` or
 * `'My ''Sheet'''!A1:C4`. Anything else (several areas, functions, constants, `#REF!`) is undefined.
 */
export function parseSheetRange(
  formula: string,
  budget: XmlContext['budget'],
): { sheet: string; range: XlsxRange } | undefined {
  const text = formula.trim();
  let sheet = '';
  let index: number;
  if (text.startsWith("'")) {
    index = 1;
    for (;;) {
      budget.tick();
      const quote = text.indexOf("'", index);
      if (quote < 0) return undefined;
      sheet += text.slice(index, quote);
      if (text[quote + 1] === "'") {
        sheet += "'";
        index = quote + 2;
      } else {
        index = quote + 1;
        break;
      }
    }
    if (text[index] !== '!') return undefined;
  } else {
    index = text.indexOf('!');
    if (index <= 0) return undefined;
    sheet = text.slice(0, index);
    // `#REF!` is what Excel writes when the sheet a name pointed to was deleted.
    if (sheet === '#REF') return undefined;
  }
  const range = parseRangeReference(text.slice(index + 1));
  return sheet.length > 0 && range ? { sheet, range } : undefined;
}

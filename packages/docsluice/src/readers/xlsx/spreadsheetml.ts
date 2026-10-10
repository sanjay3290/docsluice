import type { XmlContext } from '../../xml/index.js';

/** Transitional and Strict SpreadsheetML main namespaces (ECMA-376 Part 1, 18). */
export const SHEET_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
  'http://purl.oclc.org/ooxml/spreadsheetml/main',
]);

/** Transitional and Strict relationship namespaces used by `r:id` attributes. */
export const RELATIONSHIP_NAMESPACES: ReadonlySet<string> = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);

/** Excel's grid: 1,048,576 rows and 16,384 columns (XFD). */
export const MAX_ROW = 1_048_576;
export const MAX_COLUMN = 16_384;

/** Namespace declarations made by one element's attributes (`xmlns`, `xmlns:p`). */
export function namespaceScope(
  attrs: Map<string, string>,
  budget: XmlContext['budget'],
): Map<string, string> {
  const scope = new Map<string, string>();
  for (const [key, value] of attrs) {
    budget.tick();
    if (key === 'xmlns') scope.set('', value);
    else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
  }
  return scope;
}

/** A prefixed attribute whose prefix resolves to one of `namespaces` through the open scopes. */
export function namespacedAttribute(
  attrs: Map<string, string>,
  local: string,
  namespaces: ReadonlySet<string>,
  scopes: readonly Map<string, string>[],
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== local) continue;
    const prefix = qualifiedName.slice(0, colon);
    for (let index = scopes.length - 1; index >= 0; index--) {
      budget.tick();
      const uri = scopes[index]!.get(prefix);
      if (uri !== undefined) {
        if (namespaces.has(uri)) return value;
        break;
      }
    }
  }
  return undefined;
}

/** Parse a decimal row number or index; anything else (signs, spaces, overflow) is undefined. */
export function parseIndex(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 10) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result <= max ? result : undefined;
}

/** A1-style reference (`B7`, `$B$7`) as 1-based row and column, or undefined when invalid. */
export function parseCellReference(value: string | undefined): { row: number; column: number } | undefined {
  if (value === undefined || value.length === 0 || value.length > 16) return undefined;
  let index = 0;
  if (value.charCodeAt(index) === 36) index++;
  let column = 0;
  let letters = 0;
  while (index < value.length) {
    let code = value.charCodeAt(index);
    if (code >= 97 && code <= 122) code -= 32;
    if (code < 65 || code > 90) break;
    column = column * 26 + code - 64;
    letters++;
    index++;
  }
  if (letters === 0 || letters > 3 || column > MAX_COLUMN) return undefined;
  if (value.charCodeAt(index) === 36) index++;
  const row = parseIndex(value.slice(index), MAX_ROW);
  return row === undefined || row === 0 ? undefined : { row, column };
}

/** A1-style range (`A1:C3`, or one cell), normalized so the first corner is the top left. */
export function parseRangeReference(
  value: string | undefined,
): { top: number; left: number; bottom: number; right: number } | undefined {
  if (value === undefined) return undefined;
  const colon = value.indexOf(':');
  const start = parseCellReference(colon < 0 ? value : value.slice(0, colon));
  const end = colon < 0 ? start : parseCellReference(value.slice(colon + 1));
  if (!start || !end) return undefined;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  };
}

/** Column letters for a 1-based column number: 1 → A, 27 → AA, 16384 → XFD. */
export function columnName(column: number): string {
  let rest = column;
  let name = '';
  while (rest > 0) {
    const digit = (rest - 1) % 26;
    name = String.fromCharCode(65 + digit) + name;
    rest = Math.floor((rest - 1) / 26);
  }
  return name;
}

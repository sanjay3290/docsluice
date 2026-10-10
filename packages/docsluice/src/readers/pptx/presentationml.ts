import type { XmlContext } from '../../xml/index.js';

export const P_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
export const DGM_NS = 'http://schemas.openxmlformats.org/drawingml/2006/diagram';
export const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';

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

/** A prefixed attribute whose prefix resolves to `namespace` through the open scopes (`r:id`). */
export function namespacedAttribute(
  attrs: Map<string, string>,
  local: string,
  namespace: string,
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
        if (uri === namespace) return value;
        break;
      }
    }
  }
  return undefined;
}

/** A DrawingML coordinate (EMU): an optionally signed integer of at most 12 digits. */
export function parseCoordinate(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 13) return undefined;
  let index = 0;
  let sign = 1;
  if (value.charCodeAt(0) === 45) {
    sign = -1;
    index = 1;
  }
  if (index >= value.length) return undefined;
  let result = 0;
  for (; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return sign * result;
}

/** A small non-negative integer attribute (levels, spans, start numbers). */
export function parseSmall(value: string | undefined, max: number): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 6) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result <= max ? result : undefined;
}

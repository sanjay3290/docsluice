import type { XmlContext } from '../../xml/index.js';

export const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

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

/** A WordprocessingML-namespaced attribute value, resolving prefixes through the open scopes. */
export function wordAttribute(
  attrs: Map<string, string>,
  local: string,
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
        if (uri === WORD_NS) return value;
        break;
      }
    }
  }
  return undefined;
}

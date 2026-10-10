import type { Budget } from '../core/budget.js';
import type { XmlElement } from '../xml/index.js';

export const ODF_OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
export const ODF_META_NS = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
export const ODF_STYLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
export const ODF_MANIFEST_NS = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
export const DUBLIN_CORE_NS = 'http://purl.org/dc/elements/1.1/';

export interface OdfElement {
  element: XmlElement;
  namespaces: Map<string, string>;
  parent?: XmlElement;
  parentNamespaceScope?: OdfElement;
}

/** Walk a parsed XML tree in document order and retain each element's namespace scope. */
export function odfElements(root: XmlElement | undefined, budget: Budget): OdfElement[] {
  if (!root) return [];
  const result: OdfElement[] = [];
  const stack: Array<{ element: XmlElement; parent?: XmlElement; parentNamespaceScope?: OdfElement }> = [
    { element: root },
  ];
  while (stack.length > 0) {
    budget.tick();
    const current = stack.pop()!;
    const namespaces = new Map<string, string>();
    for (const [name, value] of current.element.attrs) {
      budget.tick();
      if (name === 'xmlns') namespaces.set('', value);
      else if (name.startsWith('xmlns:')) namespaces.set(name.slice(6), value);
    }
    const item: OdfElement = {
      element: current.element,
      namespaces,
      ...(current.parent ? { parent: current.parent } : {}),
      ...(current.parentNamespaceScope ? { parentNamespaceScope: current.parentNamespaceScope } : {}),
    };
    result.push(item);
    for (let index = current.element.children.length - 1; index >= 0; index -= 1) {
      budget.tick();
      const child = current.element.children[index];
      if (child && typeof child !== 'string') {
        stack.push({ element: child, parent: current.element, parentNamespaceScope: item });
      }
    }
  }
  return result;
}

/** Get an attribute only when its in-scope prefix resolves to the requested namespace. */
export function odfAttribute(
  item: OdfElement,
  namespaceURI: string,
  localName: string,
  budget: Budget,
): string | undefined {
  for (const [qualifiedName, value] of item.element.attrs) {
    budget.tick();
    const separator = qualifiedName.indexOf(':');
    if (separator <= 0 || qualifiedName.slice(separator + 1) !== localName) continue;
    const prefix = qualifiedName.slice(0, separator);
    if (prefix === 'xmlns') continue;
    let scope: OdfElement | undefined = item;
    let namespaceFound = false;
    let resolvedNamespace: string | undefined;
    while (scope !== undefined) {
      budget.tick();
      if (scope.namespaces.has(prefix)) {
        namespaceFound = true;
        resolvedNamespace = scope.namespaces.get(prefix);
        break;
      }
      scope = scope.parentNamespaceScope;
    }
    if (namespaceFound && resolvedNamespace === namespaceURI) return value;
  }
  return undefined;
}

export function odfText(element: XmlElement, budget: Budget): string {
  const pieces: string[] = [];
  const stack: Array<XmlElement | string> = [element];
  while (stack.length > 0) {
    budget.tick();
    const current = stack.pop()!;
    if (typeof current === 'string') {
      pieces.push(current);
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      budget.tick();
      stack.push(current.children[index]!);
    }
  }
  return pieces.join('').trim();
}

export function odfWarn(
  ctx: {
    warnings: { add(warning: { code: string; message: string; loc?: { path: string } }): void };
    path?: string;
  },
  code: string,
  message: string,
): void {
  ctx.warnings.add({ code, message, ...(ctx.path ? { loc: { path: ctx.path } } : {}) });
}

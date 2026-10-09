import type { XmlContext, XmlElementInfo } from './tokenizer.js';
import { scanXml } from './tokenizer.js';

/** A small XML element tree. Names and attributes are retained as written. */
export interface XmlElement extends XmlElementInfo {
  attrs: Map<string, string>;
  children: Array<XmlElement | string>;
}

/** Parse a small XML part into a tree without recursive descent or traversal. */
export function parseXml(input: Uint8Array | string, ctx: XmlContext): XmlElement | undefined {
  let root: XmlElement | undefined;
  const stack: XmlElement[] = [];
  scanXml(
    input,
    {
      onOpen(name, attrs, info) {
        const element: XmlElement = { ...info, attrs: new Map(attrs), children: [] };
        const parent = stack.at(-1);
        if (parent) parent.children.push(element);
        else if (!root) root = element;
        stack.push(element);
      },
      onText(text) {
        const parent = stack.at(-1);
        if (parent) parent.children.push(text);
      },
      onClose() {
        stack.pop();
      },
    },
    ctx,
  );
  return root;
}

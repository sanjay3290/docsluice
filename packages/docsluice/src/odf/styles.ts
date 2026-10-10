import type { XmlContext } from '../xml/index.js';
import type { XmlElement } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import {
  ODF_OFFICE_NS,
  ODF_STYLE_NS,
  odfAttribute,
  odfElements,
  odfWarn,
  type OdfElement,
} from './common.js';

export interface OdfStyle {
  name: string;
  family?: string;
  parentStyleName?: string;
  outlineLevel?: number;
}

/**
 * Parse named styles from normative ODF document roots and direct office styles containers.
 * Style fragments without an `office:document-*` root are ignored.
 */
export function parseOdfStyles(input: Uint8Array | string, ctx: XmlContext): Map<string, OdfStyle> {
  const styles = new Map<string, OdfStyle>();
  const root = parseXml(input, ctx);
  if (!root) return styles;
  if (
    root.namespaceURI !== ODF_OFFICE_NS ||
    (root.localName !== 'document-styles' &&
      root.localName !== 'document-content' &&
      root.localName !== 'document')
  ) {
    odfWarn(ctx, 'UNREADABLE_PART', 'ODF styles have an invalid document root.');
    return styles;
  }
  const elements = odfElements(root, ctx.budget);
  const scopeByElement = new Map<OdfElement['element'], OdfElement>();
  for (const item of elements) {
    ctx.budget.tick();
    scopeByElement.set(item.element, item);
  }
  const containers: XmlElement[] = [];
  for (const child of root.children) {
    ctx.budget.tick();
    if (
      typeof child !== 'string' &&
      child.namespaceURI === ODF_OFFICE_NS &&
      (child.localName === 'styles' || child.localName === 'automatic-styles')
    ) {
      containers.push(child);
    }
  }
  for (const container of containers) {
    ctx.budget.tick();
    for (const child of container.children) {
      ctx.budget.tick();
      if (typeof child === 'string' || child.namespaceURI !== ODF_STYLE_NS || child.localName !== 'style')
        continue;
      const item = scopeByElement.get(child);
      if (!item) continue;
      const name = odfAttribute(item, ODF_STYLE_NS, 'name', ctx.budget);
      if (!name) {
        odfWarn(ctx, 'UNREADABLE_PART', 'ODF style is missing a name.');
        continue;
      }
      if (styles.has(name)) {
        odfWarn(ctx, 'UNREADABLE_PART', 'ODF styles contain a duplicate style name.');
        continue;
      }
      const style: OdfStyle = { name };
      const family = odfAttribute(item, ODF_STYLE_NS, 'family', ctx.budget);
      const parentStyleName = odfAttribute(item, ODF_STYLE_NS, 'parent-style-name', ctx.budget);
      const directLevel = odfAttribute(item, ODF_STYLE_NS, 'default-outline-level', ctx.budget);
      if (family) style.family = family;
      if (parentStyleName) style.parentStyleName = parentStyleName;
      const outlineLevel = directLevel === undefined ? undefined : validLevel(directLevel, ctx);
      if (outlineLevel !== undefined) style.outlineLevel = outlineLevel;
      for (const styleChild of child.children) {
        ctx.budget.tick();
        if (
          typeof styleChild !== 'string' &&
          styleChild.namespaceURI === ODF_STYLE_NS &&
          styleChild.localName === 'paragraph-properties'
        ) {
          const properties = scopeByElement.get(styleChild);
          const raw = properties
            ? odfAttribute(properties, ODF_STYLE_NS, 'default-outline-level', ctx.budget)
            : undefined;
          const level = raw === undefined ? undefined : validLevel(raw, ctx);
          if (style.outlineLevel === undefined && level !== undefined) style.outlineLevel = level;
        }
      }
      styles.set(name, style);
    }
  }
  return styles;
}

export type ResolvedOdfStyle = OdfStyle;

/** Resolve a style and its parents iteratively, taking the nearest defined values. */
export function resolveOdfStyle(
  styles: ReadonlyMap<string, OdfStyle>,
  name: string,
  ctx: Pick<XmlContext, 'budget' | 'warnings' | 'path'>,
): ResolvedOdfStyle | undefined {
  const resolved: ResolvedOdfStyle = { name };
  const visited = new Set<string>();
  let currentName: string | undefined = name;
  let traversed = 0;
  let first = true;
  while (currentName !== undefined) {
    ctx.budget.tick();
    if (visited.has(currentName)) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODF style inheritance contains a cycle.');
      break;
    }
    if (traversed >= ctx.budget.limits.xmlDepth) {
      odfWarn(ctx, 'DEPTH_LIMIT', 'ODF style inheritance exceeded the configured depth.');
      break;
    }
    visited.add(currentName);
    traversed += 1;
    const style = styles.get(currentName);
    if (!style) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODF style inheritance refers to a missing parent.');
      break;
    }
    if (first) {
      resolved.name = style.name;
      first = false;
    }
    if (resolved.family === undefined && style.family !== undefined) resolved.family = style.family;
    if (resolved.parentStyleName === undefined && style.parentStyleName !== undefined) {
      resolved.parentStyleName = style.parentStyleName;
    }
    if (resolved.outlineLevel === undefined && style.outlineLevel !== undefined) {
      resolved.outlineLevel = style.outlineLevel;
    }
    currentName = style.parentStyleName;
  }
  return styles.has(name) ? resolved : undefined;
}

function validLevel(value: string, ctx: XmlContext): number | undefined {
  let level = 0;
  if (value.length === 0) return undefined;
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    level = level * 10 + code - 48;
    if (!Number.isSafeInteger(level) || level > 10) return undefined;
  }
  return level > 0 ? level : undefined;
}

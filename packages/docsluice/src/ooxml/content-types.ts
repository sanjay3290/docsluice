import type { XmlContext } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import type { OoxmlParts } from './parts.js';

export const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';

export interface OoxmlContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
  mimeType(part: string): string | undefined;
}

function warn(ctx: XmlContext): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'OOXML content types could not be read.' });
}

function lowerAscii(value: string, ctx: XmlContext): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    result += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  return result;
}

export async function readContentTypes(parts: OoxmlParts, ctx: XmlContext): Promise<OoxmlContentTypes> {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const seenDefaults = new Set<string>();
  const seenOverrides = new Set<string>();
  const duplicateDefaults = new Set<string>();
  const duplicateOverrides = new Set<string>();
  const bytes = await parts.read('[Content_Types].xml');
  if (bytes) {
    const root = parseXml(bytes, ctx);
    if (!root || root.namespaceURI !== CONTENT_TYPES_NAMESPACE || root.localName !== 'Types') warn(ctx);
    else {
      for (const node of root.children) {
        ctx.budget.tick();
        if (typeof node === 'string') continue;
        if (node.namespaceURI === CONTENT_TYPES_NAMESPACE) {
          const isDefault = node.localName === 'Default';
          const isOverride = node.localName === 'Override';
          if (isDefault || isOverride) {
            const key = node.attrs.get(isDefault ? 'Extension' : 'PartName');
            const value = node.attrs.get('ContentType');
            const map = isDefault ? defaults : overrides;
            const seen = isDefault ? seenDefaults : seenOverrides;
            const duplicates = isDefault ? duplicateDefaults : duplicateOverrides;
            const normalized = isDefault
              ? key === undefined
                ? undefined
                : lowerAscii(key, ctx)
              : key?.startsWith('/')
                ? key.slice(1)
                : undefined;
            const unsafe =
              !normalized ||
              normalized.includes('\\') ||
              normalized.includes('\0') ||
              (isDefault
                ? normalized.includes('/')
                : normalized.split('/').some((segment) => segment === '.' || segment === '..' || !segment));
            const duplicate = normalized !== undefined && seen.has(normalized);
            if (normalized) seen.add(normalized);
            if (duplicate && normalized) duplicates.add(normalized);
            if (unsafe || !value || duplicate || (normalized !== undefined && duplicates.has(normalized))) {
              warn(ctx);
              if (normalized) map.delete(normalized);
            } else map.set(normalized, value);
          }
        }
      }
    }
  }
  for (const key of duplicateDefaults) {
    ctx.budget.tick();
    defaults.delete(key);
  }
  for (const key of duplicateOverrides) {
    ctx.budget.tick();
    overrides.delete(key);
  }
  return {
    defaults,
    overrides,
    mimeType(part) {
      const override = overrides.get(part);
      if (override) return override;
      const slash = part.lastIndexOf('/');
      const dot = part.lastIndexOf('.');
      return dot > slash ? defaults.get(lowerAscii(part.slice(dot + 1), ctx)) : undefined;
    },
  };
}

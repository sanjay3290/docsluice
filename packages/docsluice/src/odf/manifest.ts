import type { XmlContext } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import { ODF_MANIFEST_NS, odfAttribute, odfElements, odfWarn } from './common.js';

export interface OdfManifestEntry {
  mediaType: string;
  encrypted: boolean;
}

export interface OdfManifest {
  /**
   * Safe internal part names only, kept as exact undecoded ZIP entry keys.
   * Consumers must not URI-decode these names before archive lookup.
   */
  entries: Map<string, OdfManifestEntry>;
  hasEncryptedEntries: boolean;
}

/**
 * Parse direct `manifest:file-entry` children of a `manifest:manifest` root without
 * opening parts, following paths, URI-decoding keys, or decrypting data.
 * Percent-encoded path separators and dots are rejected.
 */
export function parseOdfManifest(input: Uint8Array | string, ctx: XmlContext): OdfManifest {
  const result: OdfManifest = { entries: new Map(), hasEncryptedEntries: false };
  const root = parseXml(input, ctx);
  if (!root) return result;
  if (root.namespaceURI !== ODF_MANIFEST_NS || root.localName !== 'manifest') {
    odfWarn(ctx, 'UNREADABLE_PART', 'ODF manifest has an invalid document root.');
    return result;
  }
  const elements = odfElements(root, ctx.budget);
  const scopeByElement = new Map<typeof root, (typeof elements)[number]>();
  for (const item of elements) {
    ctx.budget.tick();
    scopeByElement.set(item.element, item);
  }
  for (const item of elements) {
    ctx.budget.tick();
    const { element } = item;
    if (
      item.parent !== root ||
      element.namespaceURI !== ODF_MANIFEST_NS ||
      element.localName !== 'file-entry'
    )
      continue;
    let encrypted = false;
    for (const child of element.children) {
      ctx.budget.tick();
      if (
        typeof child !== 'string' &&
        child.namespaceURI === ODF_MANIFEST_NS &&
        child.localName === 'encryption-data'
      ) {
        encrypted = true;
        result.hasEncryptedEntries = true;
      }
    }
    const path = odfAttribute(item, ODF_MANIFEST_NS, 'full-path', ctx.budget);
    const mediaType = odfAttribute(item, ODF_MANIFEST_NS, 'media-type', ctx.budget);
    if (path === undefined || mediaType === undefined || !isSafePartPath(path, ctx.budget)) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODF manifest contains an invalid internal part entry.');
      continue;
    }
    // The ODF root entry describes the package and is not a part that a reader may open.
    if (path === '/') continue;
    if (result.entries.has(path)) {
      odfWarn(ctx, 'UNREADABLE_PART', 'ODF manifest contains a duplicate part path.');
      continue;
    }
    result.entries.set(path, { mediaType, encrypted });
  }
  return result;
}

function isSafePartPath(path: string, budget: XmlContext['budget']): boolean {
  if (path === '/') return true;
  if (path.length === 0) return false;
  let segmentStart = 0;
  let firstColon = -1;
  let sawSlash = false;
  for (let index = 0; index < path.length; index += 1) {
    budget.tick();
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || code === 92 || (index === 0 && code === 47)) return false;
    if (code === 37 && index + 2 < path.length) {
      budget.tick();
      budget.tick();
      const first = hexValue(path.charCodeAt(index + 1));
      const second = hexValue(path.charCodeAt(index + 2));
      if (first >= 0 && second >= 0) {
        const escaped = first * 16 + second;
        if (escaped === 0x2e || escaped === 0x2f || escaped === 0x5c) return false;
      }
    }
    if (code === 58 && firstColon < 0) firstColon = index;
    if (code === 47) {
      const segment = path.slice(segmentStart, index);
      if (segment === '.' || segment === '..' || segment.length === 0) return false;
      segmentStart = index + 1;
      sawSlash = true;
    }
  }
  const lastSegment = path.slice(segmentStart);
  if (lastSegment === '.' || lastSegment === '..' || lastSegment.length === 0) return false;
  if (firstColon >= 0 && (firstColon < segmentStart || !sawSlash)) return false;
  return true;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

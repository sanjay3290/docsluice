import type { XmlContext } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import type { OoxmlParts } from './parts.js';

export const RELATIONSHIPS_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships';

export interface OoxmlRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  part?: string;
}

function warn(ctx: XmlContext): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'An OOXML relationship part could not be read.' });
}

function relationshipPath(source: string): string {
  if (source === '') return '_rels/.rels';
  const slash = source.lastIndexOf('/');
  return `${slash < 0 ? '' : `${source.slice(0, slash + 1)}`}_rels/${source.slice(slash + 1)}.rels`;
}

function canonicalSource(source: string, ctx?: XmlContext): boolean {
  for (let index = 0; index < source.length; index += 1) ctx?.budget.tick();
  if (
    source.startsWith('/') ||
    source.includes('\\') ||
    source.includes('\0') ||
    source.includes('?') ||
    source.includes('#')
  )
    return false;
  if (source === '') return true;
  const segments = source.split('/');
  for (const segment of segments) {
    ctx?.budget.tick();
    if (!segment || segment === '.' || segment === '..' || segment.includes(':')) return false;
  }
  return true;
}

/** Resolve a package URI reference without permitting URL, disk, or above-root resolution. */
export function resolveInternalTarget(source: string, target: string, ctx?: XmlContext): string | undefined {
  for (let index = 0; index < target.length; index += 1) ctx?.budget.tick();
  if (!canonicalSource(source, ctx)) return undefined;
  if (
    !target ||
    target.includes('\\') ||
    target.includes('\0') ||
    target.includes('?') ||
    target.includes('#')
  )
    return undefined;
  if (/%2f|%5c/i.test(target)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return undefined;
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.includes('?') || decoded.includes('#'))
    return undefined;
  if (decoded.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) return undefined;

  const absolute = decoded.startsWith('/');
  const sourceSlash = source.lastIndexOf('/');
  const base = absolute || sourceSlash < 0 ? [] : source.slice(0, sourceSlash).split('/');
  const segments = absolute ? [] : base;
  for (const segment of decoded.split('/')) {
    ctx?.budget.tick();
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
    } else {
      if (segment.includes(':')) return undefined;
      segments.push(segment);
    }
  }
  return segments.length ? segments.join('/') : undefined;
}

/** Parse one source part's relationships. Invalid and duplicate ids are omitted. */
export async function readRelationships(
  parts: OoxmlParts,
  source: string,
  ctx: XmlContext,
): Promise<Map<string, OoxmlRelationship>> {
  const output = new Map<string, OoxmlRelationship>();
  if (!canonicalSource(source, ctx)) {
    warn(ctx);
    return output;
  }
  const bytes = await parts.read(relationshipPath(source));
  if (!bytes) return output;
  const root = parseXml(bytes, ctx);
  if (!root || root.namespaceURI !== RELATIONSHIPS_NAMESPACE || root.localName !== 'Relationships') {
    warn(ctx);
    return output;
  }
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const item of root.children) {
    ctx.budget.tick();
    if (typeof item === 'string') continue;
    if (item.namespaceURI === RELATIONSHIPS_NAMESPACE && item.localName === 'Relationship') {
      const id = item.attrs.get('Id');
      const type = item.attrs.get('Type');
      const target = item.attrs.get('Target');
      if (id && seen.has(id)) {
        output.delete(id);
        duplicates.add(id);
        warn(ctx);
        continue;
      }
      if (id) seen.add(id);
      if (!id || !type || target === undefined) {
        warn(ctx);
        continue;
      }
      const external = item.attrs.get('TargetMode') === 'External';
      const part = external ? undefined : resolveInternalTarget(source, target, ctx);
      if (!external && !part) {
        warn(ctx);
        continue;
      }
      output.set(id, { id, type, target, external, ...(part ? { part } : {}) });
    }
  }
  for (const id of duplicates) {
    ctx.budget.tick();
    output.delete(id);
  }
  return output;
}

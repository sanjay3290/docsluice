import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { parseXml, type XmlElement } from '../../xml/index.js';
import { openZip, type ZipArchive, type ZipEntry } from '../../zip/index.js';
import { emitHtml } from '../html/index.js';

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string;
}

function localAttribute(element: XmlElement, name: string): string | undefined {
  for (const [key, value] of element.attrs) {
    if (key === name || key.slice(key.lastIndexOf(':') + 1) === name) return value;
  }
  return undefined;
}

function descendants(root: XmlElement, ctx: ReadContext): XmlElement[] {
  const found: XmlElement[] = [];
  const pending: XmlElement[] = [root];
  while (pending.length > 0) {
    ctx.budget.tick();
    const element = pending.pop()!;
    found.push(element);
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index]!;
      if (typeof child !== 'string') pending.push(child);
    }
  }
  return found;
}

function textContent(root: XmlElement, ctx: ReadContext): string {
  const pending: Array<XmlElement | string> = [root];
  const chunks: string[] = [];
  while (pending.length > 0) {
    ctx.budget.tick();
    const node = pending.pop()!;
    if (typeof node === 'string') chunks.push(node);
    else
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        ctx.budget.tick();
        pending.push(node.children[index]!);
      }
  }
  return chunks.join('').trim();
}

function directTextContent(root: XmlElement, ctx: ReadContext): string {
  const chunks: string[] = [];
  for (const child of root.children) {
    ctx.budget.tick();
    if (typeof child === 'string') chunks.push(child);
  }
  return chunks.join('').trim();
}

/** Resolve a local EPUB URI while refusing schemes, roots, malformed escapes and root escapes. */
function resolvePath(base: string, reference: string, ctx: ReadContext): string | undefined {
  ctx.budget.tick();
  const withoutFragment = reference.split('#', 1)[0] ?? '';
  if (!withoutFragment || withoutFragment.startsWith('/') || withoutFragment.includes('\\')) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutFragment);
  } catch {
    return undefined;
  }
  if (decoded.startsWith('/') || decoded.includes('\\') || decoded.includes('\0')) return undefined;
  const colon = decoded.indexOf(':');
  const slash = decoded.indexOf('/');
  if (colon >= 0 && (slash < 0 || colon < slash)) return undefined;
  const parts = base ? base.split('/') : [];
  for (const segment of decoded.split('/')) {
    ctx.budget.tick();
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.length ? parts.join('/') : undefined;
}

async function readEntry(
  zip: ZipArchive,
  entry: ZipEntry,
  ctx: ReadContext,
): Promise<Uint8Array | undefined> {
  ctx.budget.tick();
  if (entry.isEncrypted) return undefined;
  const bytes = await zip.read(entry);
  return bytes ?? undefined;
}

function parsePart(bytes: Uint8Array, ctx: ReadContext): XmlElement | undefined {
  return parseXml(bytes, { budget: ctx.budget, warnings: ctx.warnings, path: ctx.path });
}

function canonicalDate(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function addUnreadable(ctx: ReadContext): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'An EPUB package part could not be read.' });
}

function encryptionReferences(root: XmlElement, ctx: ReadContext): Set<string> {
  const paths = new Set<string>();
  for (const element of descendants(root, ctx)) {
    ctx.budget.tick();
    if (element.localName !== 'CipherReference') continue;
    const uri = localAttribute(element, 'URI');
    if (uri) paths.add(uri);
  }
  return paths;
}

function chapterTitles(root: XmlElement | undefined, base: string, ctx: ReadContext): Map<string, string> {
  const titles = new Map<string, string>();
  if (!root) return titles;
  const elements = descendants(root, ctx);
  for (const element of elements) {
    ctx.budget.tick();
    if (element.localName !== 'navPoint') continue;
    let target: string | undefined;
    let title: string | undefined;
    const nested: XmlElement[] = [];
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index]!;
      if (typeof child !== 'string') nested.push(child);
    }
    while (nested.length > 0) {
      ctx.budget.tick();
      const child = nested.pop()!;
      if (child.localName === 'navPoint') continue;
      if (child.localName === 'content') target = localAttribute(child, 'src');
      else if (child.localName === 'navLabel') {
        const labels: XmlElement[] = [];
        for (let index = child.children.length - 1; index >= 0; index -= 1) {
          ctx.budget.tick();
          const labelChild = child.children[index]!;
          if (typeof labelChild !== 'string') labels.push(labelChild);
        }
        while (labels.length > 0) {
          ctx.budget.tick();
          const labelChild = labels.pop()!;
          if (labelChild.localName === 'text') {
            title = textContent(labelChild, ctx);
            break;
          }
          for (let index = labelChild.children.length - 1; index >= 0; index -= 1) {
            ctx.budget.tick();
            const descendant = labelChild.children[index]!;
            if (typeof descendant !== 'string') labels.push(descendant);
          }
        }
      } else
        for (let index = child.children.length - 1; index >= 0; index -= 1) {
          ctx.budget.tick();
          const descendant = child.children[index]!;
          if (typeof descendant !== 'string') nested.push(descendant);
        }
    }
    const path = target ? resolvePath(base, target, ctx) : undefined;
    if (path && title) titles.set(path, title);
  }
  return titles;
}

function navigationTitles(root: XmlElement | undefined, base: string, ctx: ReadContext): Map<string, string> {
  const titles = new Map<string, string>();
  if (!root) return titles;
  for (const element of descendants(root, ctx)) {
    ctx.budget.tick();
    if (element.localName !== 'a') continue;
    const href = localAttribute(element, 'href');
    const path = href ? resolvePath(base, href, ctx) : undefined;
    const title = textContent(element, ctx);
    if (path && title) titles.set(path, title);
  }
  return titles;
}

/** Read EPUB package metadata and chapter XHTML in OPF spine order. */
export const reader: Reader = {
  id: 'epub',
  mimeTypes: ['application/epub+zip'],
  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const zip = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const byName = new Map<string, ZipEntry>();
    for (const entry of zip.entries) {
      ctx.budget.tick();
      if (!byName.has(entry.name)) byName.set(entry.name, entry);
    }

    const containerEntry = byName.get('META-INF/container.xml');
    if (!containerEntry) {
      if (ctx.budget.truncated) return;
      throw new CorruptFileError();
    }
    if (containerEntry.isEncrypted) throw new EncryptedError('unsupported-encryption');
    const containerBytes = await readEntry(zip, containerEntry, ctx);
    const container = containerBytes ? parsePart(containerBytes, ctx) : undefined;
    if (!container) {
      if (ctx.budget.truncated) return;
      throw new CorruptFileError();
    }
    const rootfile = descendants(container, ctx).find((element) => element.localName === 'rootfile');
    const packagePath = rootfile
      ? resolvePath('', localAttribute(rootfile, 'full-path') ?? '', ctx)
      : undefined;
    if (!packagePath) throw new CorruptFileError();

    const packageEntry = byName.get(packagePath);
    if (!packageEntry) {
      if (ctx.budget.truncated) return;
      throw new CorruptFileError();
    }
    if (packageEntry.isEncrypted) throw new EncryptedError('unsupported-encryption');
    const packageBytes = await readEntry(zip, packageEntry, ctx);
    const opf = packageBytes ? parsePart(packageBytes, ctx) : undefined;
    if (!opf) {
      if (ctx.budget.truncated) return;
      throw new CorruptFileError();
    }
    const packageDirectory = packagePath.includes('/')
      ? packagePath.slice(0, packagePath.lastIndexOf('/'))
      : '';

    const encryptionEntry = byName.get('META-INF/encryption.xml');
    const encryptedPaths = new Set<string>();
    if (encryptionEntry) {
      ctx.out.setFeature('isEncrypted');
      const encryptionBytes = await readEntry(zip, encryptionEntry, ctx);
      const encryption = encryptionBytes ? parsePart(encryptionBytes, ctx) : undefined;
      if (encryption) {
        for (const rawPath of encryptionReferences(encryption, ctx)) {
          const path = resolvePath('', rawPath, ctx);
          if (path) encryptedPaths.add(path);
        }
      } else addUnreadable(ctx);
    }

    const elements = descendants(opf, ctx);
    const metadataElement = elements.find((element) => element.localName === 'metadata');
    if (metadataElement) {
      let title: string | undefined;
      let language: string | undefined;
      let date: string | undefined;
      const authors: string[] = [];
      let modified: string | undefined;
      for (const element of descendants(metadataElement, ctx)) {
        ctx.budget.tick();
        const text = directTextContent(element, ctx);
        if (!text) continue;
        if (element.localName === 'title' && title === undefined) title = text;
        else if (element.localName === 'creator') authors.push(text);
        else if (element.localName === 'language' && language === undefined) language = text;
        else if (element.localName === 'date' && date === undefined) date = text;
        else if (element.localName === 'meta' && localAttribute(element, 'property') === 'dcterms:modified')
          modified = text;
      }
      ctx.out.setMetadata({
        ...(title ? { title } : {}),
        ...(ctx.options.metadata && authors.length ? { authors } : {}),
        ...(language ? { language } : {}),
        ...(date && canonicalDate(date) ? { created: canonicalDate(date)! } : {}),
        ...(modified && canonicalDate(modified) ? { modified: canonicalDate(modified)! } : {}),
      });
    }

    const manifest = new Map<string, ManifestItem>();
    for (const element of elements) {
      ctx.budget.tick();
      if (element.localName !== 'item') continue;
      const id = localAttribute(element, 'id');
      const href = localAttribute(element, 'href');
      if (!id || !href) continue;
      const path = resolvePath(packageDirectory, href, ctx);
      if (!path) {
        addUnreadable(ctx);
        continue;
      }
      if (!manifest.has(id))
        manifest.set(id, {
          id,
          path,
          mediaType: localAttribute(element, 'media-type') ?? '',
          properties: localAttribute(element, 'properties') ?? '',
        });
    }

    const spine = elements.find((element) => element.localName === 'spine');
    if (!spine) {
      addUnreadable(ctx);
      return;
    }
    const spineRefs: XmlElement[] = [];
    for (const child of spine.children) {
      ctx.budget.tick();
      if (typeof child !== 'string' && child.localName === 'itemref') spineRefs.push(child);
    }
    let navTitles = new Map<string, string>();
    let ncxTitles = new Map<string, string>();
    for (const item of manifest.values()) {
      ctx.budget.tick();
      const isNcx = item.mediaType === 'application/x-dtbncx+xml';
      const isNav = item.properties.split(/\s+/).includes('nav');
      if (!isNcx && !isNav) continue;
      const entry = byName.get(item.path);
      if (!entry) {
        addUnreadable(ctx);
        continue;
      }
      if (entry.isEncrypted || encryptedPaths.has(item.path)) {
        ctx.out.setFeature('isEncrypted');
        addUnreadable(ctx);
        continue;
      }
      const bytes = await readEntry(zip, entry, ctx);
      const root = bytes ? parsePart(bytes, ctx) : undefined;
      const navigationDirectory = item.path.includes('/')
        ? item.path.slice(0, item.path.lastIndexOf('/'))
        : '';
      if (isNav) navTitles = navigationTitles(root, navigationDirectory, ctx);
      if (isNcx) ncxTitles = chapterTitles(root, navigationDirectory, ctx);
    }

    for (const ref of spineRefs) {
      ctx.budget.tick();
      if (ctx.budget.outputChars >= ctx.budget.limits.outputChars) {
        ctx.budget.checkOutputChars(1);
        return;
      }
      const idref = localAttribute(ref, 'idref');
      const item = idref ? manifest.get(idref) : undefined;
      if (!item || item.mediaType !== 'application/xhtml+xml') {
        addUnreadable(ctx);
        continue;
      }
      // The existing shared includeHidden option is the only public switch for auxiliary/hidden content.
      if (localAttribute(ref, 'linear')?.toLowerCase() === 'no' && !ctx.options.includeHidden) continue;
      const entry = byName.get(item.path);
      if (!entry) {
        addUnreadable(ctx);
        continue;
      }
      if (entry.isEncrypted || encryptedPaths.has(item.path)) {
        ctx.out.setFeature('isEncrypted');
        addUnreadable(ctx);
        continue;
      }
      const bytes = await readEntry(zip, entry, ctx);
      if (!bytes) {
        addUnreadable(ctx);
        continue;
      }
      const chapter = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const title = navTitles.get(item.path) ?? ncxTitles.get(item.path);
      const location = ctx.path ? `${ctx.path}/${item.path}` : item.path;
      if (title && !ctx.budget.checkOutputChars(title.length)) return;
      ctx.out.openSection('part', { path: location }, title);
      let completed: boolean;
      try {
        const chapterContext = { ...ctx, path: location };
        emitHtml(chapterContext, chapter);
      } finally {
        completed = ctx.out.closeSection();
      }
      if (!completed) return;
    }
  },
};

export default reader;

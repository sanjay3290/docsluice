import type { Reader, ReadContext } from '../../core/reader.js';
import { EncryptedError } from '../../core/errors.js';
import type { Cell, ListItem, Location, Run } from '../../core/model.js';
import { parseOdfManifest, parseOdfMetadata, parseOdfStyles, resolveOdfStyle } from '../../odf/index.js';
import {
  DUBLIN_CORE_NS,
  ODF_OFFICE_NS,
  ODF_STYLE_NS,
  odfAttribute,
  odfElements,
  type OdfElement,
} from '../../odf/common.js';
import { parseXml, type XmlElement } from '../../xml/index.js';
import { openZip, type ZipEntry } from '../../zip/index.js';

const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const DRAW_NS = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const SVG_NS = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const MIMETYPE = 'application/vnd.oasis.opendocument.text';
/** `number-columns-repeated` is honoured up to this many copies per cell; each copy is charged to `cells`. */
const MAX_REPEATED_CELLS = 1024;
const KNOWN_ODF_NAMESPACES = new Set([
  ODF_OFFICE_NS,
  TEXT_NS,
  TABLE_NS,
  DRAW_NS,
  SVG_NS,
  ODF_STYLE_NS,
  DUBLIN_CORE_NS,
  XLINK_NS,
]);

type XmlNode = XmlElement | string;

interface WalkFrame {
  element: XmlElement;
  index: number;
}

interface TrackedChange {
  kind: 'insertion' | 'deletion';
  text: string;
}

/** Internal ODT reader. It reads package XML and lists safe image children without fetching targets. */
export const odtReader: Reader = {
  id: 'odt',
  mimeTypes: [MIMETYPE],
  async read(ctx: ReadContext): Promise<void> {
    const zip = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const entries = new Map<string, ZipEntry | null>();
    const duplicateNames = new Set<string>();
    for (const entry of zip.entries) {
      ctx.budget.tick();
      if (entries.has(entry.name)) {
        entries.set(entry.name, null);
        duplicateNames.add(entry.name);
      } else entries.set(entry.name, entry);
    }
    for (const name of duplicateNames) {
      ctx.budget.tick();
      warn(ctx, 'UNREADABLE_PART', 'ODT package contains duplicate exact part names.', name);
    }

    const readPart = async (name: string): Promise<Uint8Array | undefined> => {
      ctx.budget.tick();
      const entry = entries.get(name);
      if (entry === null) return undefined;
      if (!entry) return undefined;
      if (entry.isEncrypted) throw new EncryptedError('password-required');
      if (entry.isUnreadable) {
        warn(ctx, 'UNREADABLE_PART', 'ODT package part is unreadable.', name);
        return undefined;
      }
      const data = await zip.read(entry);
      if (!data) warn(ctx, 'UNREADABLE_PART', 'ODT package part is unreadable.', name);
      return data ?? undefined;
    };

    const manifestBytes = await readPart('META-INF/manifest.xml');
    let manifest = {
      entries: new Map<string, { mediaType: string; encrypted: boolean }>(),
      hasEncryptedEntries: false,
    };
    if (manifestBytes) {
      manifest = parseOdfManifest(manifestBytes, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path: 'META-INF/manifest.xml',
      });
      if (manifest.hasEncryptedEntries) throw new EncryptedError('password-required');
    }
    const metadataBytes = await readPart('meta.xml');
    if (metadataBytes)
      ctx.out.setMetadata(
        parseOdfMetadata(
          metadataBytes,
          { budget: ctx.budget, warnings: ctx.warnings, path: 'meta.xml' },
          { metadata: ctx.options.metadata },
        ),
      );

    const styles = new Map();
    const stylesBytes = await readPart('styles.xml');
    if (stylesBytes) {
      const path = 'styles.xml';
      for (const [name, style] of parseOdfStyles(stylesBytes, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path,
      }).entries()) {
        ctx.budget.tick();
        if (!styles.has(name)) styles.set(name, style);
      }
    }
    const contentBytes = await readPart('content.xml');
    if (!contentBytes) {
      warn(ctx, 'UNREADABLE_PART', 'ODT content part is missing or unreadable.', 'content.xml');
      return;
    }
    const content = parseXml(contentBytes, {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: 'content.xml',
    });
    if (
      !content ||
      content.namespaceURI !== ODF_OFFICE_NS ||
      (content.localName !== 'document-content' && content.localName !== 'document')
    ) {
      warn(ctx, 'UNREADABLE_PART', 'ODT content has an invalid document root.', 'content.xml');
      return;
    }
    for (const [name, style] of parseOdfStyles(contentBytes, {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: 'content.xml',
    }).entries()) {
      ctx.budget.tick();
      if (!styles.has(name)) styles.set(name, style);
    }
    const scopes = scopeMap(content, ctx);
    const listStyles = parseListStyles(content, scopes, ctx);
    if (stylesBytes) {
      const styleRoot = parseXml(stylesBytes, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path: 'styles.xml',
      });
      if (
        styleRoot &&
        styleRoot.namespaceURI === ODF_OFFICE_NS &&
        styleRoot.localName === 'document-styles'
      ) {
        const styleScopes = scopeMap(styleRoot, ctx);
        for (const [name, ordered] of parseListStyles(styleRoot, styleScopes, ctx)) {
          ctx.budget.tick();
          if (!listStyles.has(name)) listStyles.set(name, ordered);
        }
      }
    }
    const body = directChild(content, ODF_OFFICE_NS, 'body', ctx);
    const officeText = body ? directChild(body, ODF_OFFICE_NS, 'text', ctx) : undefined;
    if (!officeText) {
      warn(ctx, 'UNREADABLE_PART', 'ODT content has no office text body.', 'content.xml');
      return;
    }
    detectExternalLinks(content, scopes, ctx);
    detectTrackedChanges(content, ctx);
    const trackedChanges = parseTrackedChanges(officeText, scopes, ctx);
    const emittedImages = new Set<string>();
    const stack: WalkFrame[] = [{ element: officeText, index: 0 }];
    while (stack.length > 0) {
      ctx.budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.element.children.length) {
        stack.pop();
        continue;
      }
      const child = frame.element.children[frame.index++]!;
      if (typeof child === 'string') continue;
      if (child.namespaceURI === ODF_OFFICE_NS && child.localName === 'annotation') {
        addAnnotation(child, scopes, ctx);
      } else if (child.namespaceURI === TABLE_NS && child.localName === 'table') {
        addTable(child, scopes, trackedChanges, ctx);
        for (const nested of collectNestedTables(child, ctx)) addTable(nested, scopes, trackedChanges, ctx);
        emitDescendantNotes(child, scopes, ctx);
        await addImages(child, scopes, manifest.entries, entries, emittedImages, ctx, readPart);
      } else if (child.namespaceURI === TEXT_NS && child.localName === 'list') {
        const list = parseList(child, scopes, listStyles, trackedChanges, ctx);
        if (list) ctx.out.list(list.ordered, list.items, location('content.xml'));
        emitDescendantNotes(child, scopes, ctx);
        await addImages(child, scopes, manifest.entries, entries, emittedImages, ctx, readPart);
      } else if (child.namespaceURI === TEXT_NS && (child.localName === 'p' || child.localName === 'h')) {
        emitParagraph(child, scopes, styles, trackedChanges, ctx);
        emitDescendantNotes(child, scopes, ctx);
        await addImages(child, scopes, manifest.entries, entries, emittedImages, ctx, readPart);
      } else if (child.namespaceURI === DRAW_NS && child.localName === 'frame') {
        await addImages(child, scopes, manifest.entries, entries, emittedImages, ctx, readPart);
      } else if (child.namespaceURI === TEXT_NS && child.localName === 'section') {
        stack.push({ element: child, index: 0 });
      }
    }
  },
};


function warn(ctx: ReadContext, code: string, message: string, path?: string): void {
  ctx.warnings.add({ code, message, loc: { path: path ?? 'content.xml' } });
}

function location(path: string): Location {
  return { path: path ? `${path}` : 'content.xml' };
}

function directChild(
  parent: XmlElement,
  ns: string,
  local: string,
  ctx: ReadContext,
): XmlElement | undefined {
  for (const child of parent.children) {
    ctx.budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === ns && child.localName === local) return child;
  }
  return undefined;
}

function scopeMap(root: XmlElement, ctx: ReadContext): Map<XmlElement, OdfElement> {
  const scopes = new Map<XmlElement, OdfElement>();
  for (const item of odfElements(root, ctx.budget)) {
    ctx.budget.tick();
    scopes.set(item.element, item);
  }
  return scopes;
}

function attr(
  element: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  ns: string,
  local: string,
  ctx: ReadContext,
): string | undefined {
  const item = scopes.get(element);
  return item ? odfAttribute(item, ns, local, ctx.budget) : undefined;
}

function directText(
  element: XmlElement,
  ctx: ReadContext,
  excludeNotes = true,
  scopes?: Map<XmlElement, OdfElement>,
): string {
  let result = '';
  const stack: XmlNode[] = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    stack.push(element.children[index]!);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (typeof current === 'string') {
      result += current;
      continue;
    }
    if (excludeNotes && current.namespaceURI === TEXT_NS && current.localName === 'note') continue;
    if (current.namespaceURI === ODF_OFFICE_NS && current.localName === 'annotation') continue;
    if (current.namespaceURI === DRAW_NS && current.localName === 'frame') continue;
    if (current.namespaceURI === TEXT_NS && current.localName === 's') {
      const raw = scopes ? (attr(current, scopes, TEXT_NS, 'c', ctx) ?? '1') : '1';
      const count = boundedNumber(raw, 1, ctx.budget.limits.outputChars, ctx);
      for (let i = 0; i < count; i += 1) {
        ctx.budget.tick();
        result += ' ';
      }
      continue;
    }
    if (current.namespaceURI === TEXT_NS && current.localName === 'tab') {
      result += '\t';
      continue;
    }
    if (current.namespaceURI === TEXT_NS && current.localName === 'line-break') {
      result += '\n';
      continue;
    }
    if (!KNOWN_ODF_NAMESPACES.has(current.namespaceURI ?? '')) continue;
    const children = current.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      stack.push(children[index]!);
    }
  }
  return result.trim();
}

function boundedNumber(value: string, fallback: number, max: number, ctx: ReadContext): number {
  if (value.length === 0 || value.length > 8) return fallback;
  let number = 0;
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return fallback;
    number = number * 10 + code - 48;
  }
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : fallback;
}

function emitParagraph(
  element: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  styles: ReadonlyMap<
    string,
    { name: string; outlineLevel?: number; parentStyleName?: string; family?: string }
  >,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): void {
  const textValue = trackedText(element, ctx, scopes, trackedChanges);
  if (!textValue) return;
  const loc = location('content.xml');
  if (element.localName === 'h') {
    const rawLevel = attr(element, scopes, TEXT_NS, 'outline-level', ctx);
    const styleName = attr(element, scopes, TEXT_NS, 'style-name', ctx);
    const resolved = styleName
      ? resolveOdfStyle(styles, styleName, {
          budget: ctx.budget,
          warnings: ctx.warnings,
          path: 'content.xml',
        })
      : undefined;
    const level = boundedNumber(rawLevel ?? String(resolved?.outlineLevel ?? 1), 1, 6, ctx) as
      1 | 2 | 3 | 4 | 5 | 6;
    ctx.out.heading(level, textValue, loc);
  } else
    ctx.out.paragraph(
      textValue,
      loc,
      ctx.options.runs ? paragraphRuns(element, scopes, trackedChanges, ctx) : undefined,
    );
}

function paragraphRuns(
  element: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): Run[] {
  const runs: Run[] = [];
  const stack: Array<{
    node?: XmlNode;
    href?: string;
    revision?: 'insertion' | 'deletion';
    close?: 'insertion' | 'deletion';
  }> = [];
  const ranges: Array<{ id: string; kind: 'insertion' | 'deletion'; text: string }> = [];
  const append = (text: string, href?: string): void => {
    const last = runs[runs.length - 1];
    if (last && last.href === href) last.text += text;
    else runs.push({ text, ...(href ? { href } : {}) });
  };
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    stack.push({ node: element.children[index]! });
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const frame = stack.pop()!;
    if (frame.close) {
      append(frame.close === 'insertion' ? '+]' : '-]', frame.href);
      continue;
    }
    const node = frame.node!;
    if (typeof node === 'string') {
      const revision = frame.revision ?? ranges[ranges.length - 1]?.kind;
      const visible =
        !revision ||
        ctx.options.revisions === 'show' ||
        (ctx.options.revisions === 'accept' && revision === 'insertion') ||
        (ctx.options.revisions === 'reject' && revision === 'deletion') ||
        (ctx.options.revisions === undefined && revision === 'insertion');
      if (!visible || !node) continue;
      append(node, frame.href);
      continue;
    }
    if (
      node.namespaceURI === TEXT_NS &&
      (node.localName === 'change-start' || node.localName === 'change-end')
    ) {
      const id = attr(node, scopes, TEXT_NS, 'change-id', ctx);
      if (!id) continue;
      if (node.localName === 'change-start') {
        const change = trackedChanges.get(id);
        if (change) {
          ranges.push({ id, kind: change.kind, text: change.text });
          if (ctx.options.revisions === 'show' && change.kind === 'insertion') append('[+', frame.href);
        }
      } else {
        let rangeIndex = ranges.length - 1;
        while (rangeIndex >= 0 && ranges[rangeIndex]!.id !== id) {
          ctx.budget.tick();
          rangeIndex -= 1;
        }
        if (rangeIndex >= 0) {
          const [range] = ranges.splice(rangeIndex, 1);
          if (range) {
            if (range.kind === 'insertion' && ctx.options.revisions === 'show') append('+]', frame.href);
            if (range.kind === 'deletion') {
              const mode = ctx.options.revisions ?? 'accept';
              if (mode === 'reject' && range.text) append(range.text, frame.href);
              if (mode === 'show' && range.text) append(`[-${range.text}-]`, frame.href);
            }
          }
        }
      }
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'change') {
      const id = attr(node, scopes, TEXT_NS, 'change-id', ctx);
      const change = id ? trackedChanges.get(id) : undefined;
      if (change) {
        const mode = ctx.options.revisions ?? 'accept';
        const visible =
          mode === 'show' ||
          (mode === 'accept' && change.kind === 'insertion') ||
          (mode === 'reject' && change.kind === 'deletion');
        if (visible && change.text) {
          const text =
            mode === 'show'
              ? `${change.kind === 'insertion' ? '[+' : '[-'}${change.text}${change.kind === 'insertion' ? '+]' : '-]'}`
              : change.text;
          append(text, frame.href);
        }
      }
      continue;
    }
    let revision = frame.revision;
    if (node.namespaceURI === TEXT_NS && (node.localName === 'insertion' || node.localName === 'deletion')) {
      revision = node.localName;
      if ((ctx.options.revisions ?? 'accept') === 'accept' && revision === 'deletion') continue;
      if (ctx.options.revisions === 'reject' && revision === 'insertion') continue;
      if (ctx.options.revisions === 'show') {
        append(revision === 'insertion' ? '[+' : '[-', frame.href);
        stack.push({ close: revision, href: frame.href });
      }
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'note') continue;
    if (node.namespaceURI === ODF_OFFICE_NS && node.localName === 'annotation') continue;
    if (node.namespaceURI === DRAW_NS && node.localName === 'frame') continue;
    const href =
      node.namespaceURI === TEXT_NS && node.localName === 'a'
        ? attr(node, scopes, XLINK_NS, 'href', ctx)
        : frame.href;
    if (node.namespaceURI === TEXT_NS && node.localName === 's') {
      const count = boundedNumber(
        attr(node, scopes, TEXT_NS, 'c', ctx) ?? '1',
        1,
        ctx.budget.limits.outputChars,
        ctx,
      );
      for (let countIndex = 0; countIndex < count; countIndex += 1) {
        ctx.budget.tick();
        append(' ', href);
      }
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'tab') {
      append('\t', href);
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'line-break') {
      append('\n', href);
      continue;
    }
    if (node.namespaceURI !== TEXT_NS) continue;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      stack.push({ node: node.children[index]!, href, revision });
    }
  }
  return runs;
}

function trackedText(
  element: XmlElement,
  ctx: ReadContext,
  scopes?: Map<XmlElement, OdfElement>,
  trackedChanges: ReadonlyMap<string, TrackedChange> = new Map(),
): string {
  const mode = ctx.options.revisions ?? 'accept';
  const stack: Array<{
    node?: XmlNode;
    revision?: 'insertion' | 'deletion';
    close?: 'insertion' | 'deletion';
  }> = [];
  const ranges: Array<{ id: string; kind: 'insertion' | 'deletion'; text: string }> = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    stack.push({ node: element.children[index]! });
  }
  let result = '';
  while (stack.length > 0) {
    ctx.budget.tick();
    const frame = stack.pop()!;
    if (frame.close) {
      if (mode === 'show') result += frame.close === 'insertion' ? '+]' : '-]';
      continue;
    }
    const node = frame.node!;
    if (typeof node === 'string') {
      const revision = frame.revision ?? ranges[ranges.length - 1]?.kind;
      if (
        !revision ||
        mode === 'show' ||
        (mode === 'accept' && revision === 'insertion') ||
        (mode === 'reject' && revision === 'deletion')
      )
        result += node;
      continue;
    }
    if (
      node.namespaceURI === TEXT_NS &&
      (node.localName === 'change-start' || node.localName === 'change-end')
    ) {
      const id = scopes ? attr(node, scopes, TEXT_NS, 'change-id', ctx) : undefined;
      if (!id) continue;
      if (node.localName === 'change-start') {
        const change = trackedChanges.get(id);
        if (change) {
          ranges.push({ id, kind: change.kind, text: change.text });
          if (mode === 'show' && change.kind === 'insertion') result += '[+';
        }
      } else {
        let rangeIndex = ranges.length - 1;
        while (rangeIndex >= 0 && ranges[rangeIndex]!.id !== id) {
          ctx.budget.tick();
          rangeIndex -= 1;
        }
        if (rangeIndex >= 0) {
          const [range] = ranges.splice(rangeIndex, 1);
          if (range) {
            if (range.kind === 'insertion' && mode === 'show') result += '+]';
            if (range.kind === 'deletion' && (mode === 'reject' || mode === 'show') && range.text)
              result += mode === 'show' ? `[-${range.text}-]` : range.text;
          }
        }
      }
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'change') {
      const id = scopes ? attr(node, scopes, TEXT_NS, 'change-id', ctx) : undefined;
      const change = id ? trackedChanges.get(id) : undefined;
      if (change) {
        const visible =
          mode === 'show' ||
          (mode === 'accept' && change.kind === 'insertion') ||
          (mode === 'reject' && change.kind === 'deletion');
        if (visible && change.text) {
          result +=
            mode === 'show'
              ? `${change.kind === 'insertion' ? '[+' : '[-'}${change.text}${change.kind === 'insertion' ? '+]' : '-]'}`
              : change.text;
        }
      }
      continue;
    }
    let revision = frame.revision;
    if (node.namespaceURI === TEXT_NS && (node.localName === 'insertion' || node.localName === 'deletion')) {
      revision = node.localName;
      if (mode === 'accept' && revision === 'deletion') continue;
      if (mode === 'reject' && revision === 'insertion') continue;
      if (mode === 'show') result += revision === 'insertion' ? '[+' : '[-';
      if (mode === 'show') stack.push({ close: revision });
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'note') continue;
    if (node.namespaceURI === ODF_OFFICE_NS && node.localName === 'annotation') continue;
    if (node.namespaceURI === DRAW_NS && node.localName === 'frame') continue;
    if (node.namespaceURI === TEXT_NS && node.localName === 's') {
      const count = boundedNumber(
        scopes ? (attr(node, scopes, TEXT_NS, 'c', ctx) ?? '1') : '1',
        1,
        ctx.budget.limits.outputChars,
        ctx,
      );
      for (let i = 0; i < count; i += 1) {
        ctx.budget.tick();
        result += ' ';
      }
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'tab') {
      result += '\t';
      continue;
    }
    if (node.namespaceURI === TEXT_NS && node.localName === 'line-break') {
      result += '\n';
      continue;
    }
    if (node.namespaceURI !== TEXT_NS) continue;
    const children = node.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      stack.push({ node: children[index]!, revision });
    }
  }
  return result.trim();
}

function detectTrackedChanges(root: XmlElement, ctx: ReadContext): void {
  for (const item of odfElements(root, ctx.budget)) {
    ctx.budget.tick();
    if (
      item.element.namespaceURI === TEXT_NS &&
      (item.element.localName === 'tracked-changes' ||
        item.element.localName === 'insertion' ||
        item.element.localName === 'deletion')
    ) {
      warn(ctx, 'HIDDEN_CONTENT', 'ODT contains tracked changes.');
      return;
    }
  }
}

function parseTrackedChanges(
  officeText: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  ctx: ReadContext,
): Map<string, TrackedChange> {
  const changes = new Map<string, TrackedChange>();
  for (const child of officeText.children) {
    ctx.budget.tick();
    if (
      typeof child !== 'string' &&
      child.namespaceURI === TEXT_NS &&
      child.localName === 'tracked-changes'
    ) {
      for (const region of child.children) {
        ctx.budget.tick();
        if (
          typeof region === 'string' ||
          region.namespaceURI !== TEXT_NS ||
          region.localName !== 'changed-region'
        )
          continue;
        const id = attr(region, scopes, TEXT_NS, 'id', ctx);
        if (!id || changes.has(id)) continue;
        for (const change of region.children) {
          ctx.budget.tick();
          if (
            typeof change === 'string' ||
            change.namespaceURI !== TEXT_NS ||
            (change.localName !== 'insertion' && change.localName !== 'deletion')
          )
            continue;
          const pieces: string[] = [];
          const pending: XmlElement[] = [];
          for (const part of change.children) {
            ctx.budget.tick();
            if (
              typeof part !== 'string' &&
              part.namespaceURI === TEXT_NS &&
              (part.localName === 'p' || part.localName === 'h')
            )
              pending.push(part);
          }
          for (const paragraph of pending) {
            ctx.budget.tick();
            const text = trackedText(paragraph, ctx, scopes, changes);
            if (text) pieces.push(text);
          }
          changes.set(id, { kind: change.localName, text: pieces.join('\n') });
          break;
        }
      }
    }
  }
  return changes;
}

interface ListFrame {
  list: XmlElement;
  items: ListItem[];
  index: number;
  depth: number;
  markerStyle?: ListMarkerStyle;
}

interface ListMarkerStyle {
  ordered: boolean;
  format?: string;
  bullet?: string;
  prefix?: string;
  suffix?: string;
}
function parseList(
  root: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  listStyles: ReadonlyMap<string, ListMarkerStyle>,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): { ordered: boolean; items: ListItem[] } | undefined {
  const rootStyleName = attr(root, scopes, TEXT_NS, 'style-name', ctx);
  const top: ListFrame = {
    list: root,
    items: [],
    index: 0,
    depth: 1,
    ...(rootStyleName && listStyles.has(rootStyleName)
      ? { markerStyle: listStyles.get(rootStyleName)! }
      : {}),
  };
  const stack: ListFrame[] = [top];
  while (stack.length > 0) {
    ctx.budget.tick();
    const frame = stack[stack.length - 1]!;
    if (frame.index >= frame.list.children.length) {
      stack.pop();
      continue;
    }
    const child = frame.list.children[frame.index++]!;
    if (typeof child === 'string' || child.namespaceURI !== TEXT_NS || child.localName !== 'list-item')
      continue;
    const item: ListItem = { text: '' };
    if (frame.markerStyle) item.marker = listMarker(frame.markerStyle, frame.items.length, ctx);
    frame.items.push(item);
    for (const part of child.children) {
      ctx.budget.tick();
      if (typeof part === 'string') continue;
      if (part.namespaceURI === TEXT_NS && (part.localName === 'p' || part.localName === 'h'))
        item.text += `${item.text ? '\n' : ''}${trackedText(part, ctx, scopes, trackedChanges)}`;
      else if (part.namespaceURI === TEXT_NS && part.localName === 'list') {
        if (frame.depth >= ctx.budget.limits.blockDepth) {
          ctx.warnings.add({
            code: 'DEPTH_LIMIT',
            message: 'ODT list nesting exceeded the configured block depth.',
            loc: { path: 'content.xml' },
          });
          const flattened = flattenListText(part, scopes, trackedChanges, ctx);
          if (flattened) item.text += `${item.text ? '\n' : ''}${flattened}`;
          continue;
        }
        const nestedStyleName = attr(part, scopes, TEXT_NS, 'style-name', ctx);
        const nested: ListFrame = {
          list: part,
          items: [],
          index: 0,
          depth: frame.depth + 1,
          ...(nestedStyleName && listStyles.has(nestedStyleName)
            ? { markerStyle: listStyles.get(nestedStyleName)! }
            : {}),
        };
        item.items = nested.items;
        stack.push(nested);
      }
    }
  }
  return { ordered: top.markerStyle?.ordered ?? false, items: top.items };
}

function flattenListText(
  root: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): string {
  const paragraphs: string[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (current.namespaceURI === TEXT_NS && (current.localName === 'p' || current.localName === 'h')) {
      const text = trackedText(current, ctx, scopes, trackedChanges);
      if (text) paragraphs.push(text);
      continue;
    }
    if (
      current.namespaceURI !== TEXT_NS ||
      (current.localName !== 'list' && current.localName !== 'list-item')
    )
      continue;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  return paragraphs.join('\n');
}

function parseListStyles(
  root: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  ctx: ReadContext,
): Map<string, ListMarkerStyle> {
  const result = new Map<string, ListMarkerStyle>();
  for (const container of root.children) {
    ctx.budget.tick();
    if (
      typeof container === 'string' ||
      container.namespaceURI !== ODF_OFFICE_NS ||
      (container.localName !== 'styles' && container.localName !== 'automatic-styles')
    )
      continue;
    for (const style of container.children) {
      ctx.budget.tick();
      if (typeof style === 'string' || style.namespaceURI !== TEXT_NS || style.localName !== 'list-style')
        continue;
      const styleName = attr(style, scopes, ODF_STYLE_NS, 'name', ctx);
      if (!styleName || result.has(styleName)) continue;
      let markerStyle: ListMarkerStyle | undefined;
      for (const level of style.children) {
        ctx.budget.tick();
        if (markerStyle) continue;
        if (
          typeof level !== 'string' &&
          level.namespaceURI === TEXT_NS &&
          level.localName === 'list-level-style-number'
        ) {
          markerStyle = {
            ordered: true,
            format: attr(level, scopes, ODF_STYLE_NS, 'num-format', ctx),
            prefix: attr(level, scopes, ODF_STYLE_NS, 'num-prefix', ctx),
            suffix: attr(level, scopes, ODF_STYLE_NS, 'num-suffix', ctx),
          };
        } else if (
          typeof level !== 'string' &&
          level.namespaceURI === TEXT_NS &&
          level.localName === 'list-level-style-bullet'
        ) {
          markerStyle = { ordered: false, bullet: attr(level, scopes, TEXT_NS, 'bullet-char', ctx) ?? '•' };
        }
      }
      if (markerStyle) result.set(styleName, markerStyle);
    }
  }
  return result;
}

function listMarker(style: ListMarkerStyle, itemIndex: number, ctx: ReadContext): string {
  if (!style.ordered) return `${style.prefix ?? ''}${style.bullet ?? '•'}${style.suffix ?? ''}`;
  const format = style.format ?? '1';
  let value = String(itemIndex + 1);
  if (format === 'a' || format === 'A') {
    let remaining = itemIndex + 1;
    value = '';
    while (remaining > 0) {
      ctx.budget.tick();
      remaining -= 1;
      value = String.fromCharCode((format === 'a' ? 97 : 65) + (remaining % 26)) + value;
      remaining = Math.floor(remaining / 26);
    }
  }
  return `${style.prefix ?? ''}${value}${style.suffix ?? '.'}`;
}

function addTable(
  element: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): void {
  const rows: Cell[][] = [];
  const rowStack: Array<{ row: XmlElement; header: boolean }> = [];
  const pending: Array<{ element: XmlElement; header: boolean }> = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = element.children[index];
    if (child && typeof child !== 'string') pending.push({ element: child, header: false });
  }
  while (pending.length > 0) {
    ctx.budget.tick();
    const frame = pending.pop()!;
    if (frame.element.namespaceURI === TABLE_NS && frame.element.localName === 'table') continue;
    if (frame.element.namespaceURI === TABLE_NS && frame.element.localName === 'table-row') {
      rowStack.push({ row: frame.element, header: frame.header });
      continue;
    }
    if (!KNOWN_ODF_NAMESPACES.has(frame.element.namespaceURI ?? '')) continue;
    const header =
      frame.header ||
      (frame.element.namespaceURI === TABLE_NS && frame.element.localName === 'table-header-rows');
    for (let index = frame.element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = frame.element.children[index];
      if (child && typeof child !== 'string') pending.push({ element: child, header });
    }
  }
  let headerRows = 0;
  let stillInHeader = true;
  for (const rowFrame of rowStack) {
    ctx.budget.tick();
    const row = rowFrame.row;
    if (stillInHeader && rowFrame.header) headerRows += 1;
    else stillInHeader = false;
    const cells: Cell[] = [];
    for (const cell of row.children) {
      ctx.budget.tick();
      if (
        typeof cell === 'string' ||
        cell.namespaceURI !== TABLE_NS ||
        (cell.localName !== 'table-cell' && cell.localName !== 'covered-table-cell')
      )
        continue;
      const rawRepeat = attr(cell, scopes, TABLE_NS, 'number-columns-repeated', ctx);
      const repeat = rawRepeat
        ? Math.min(boundedNumber(rawRepeat, 1, Number.MAX_SAFE_INTEGER, ctx), MAX_REPEATED_CELLS)
        : 1;
      // A covered cell keeps its grid position, as in DOCX: the spanning cell carries the span.
      let output: Cell = { text: '' };
      if (cell.localName === 'table-cell') {
        const rawColSpan = attr(cell, scopes, TABLE_NS, 'number-columns-spanned', ctx);
        const rawRowSpan = attr(cell, scopes, TABLE_NS, 'number-rows-spanned', ctx);
        output = { text: cellText(cell, scopes, trackedChanges, ctx) };
        const colSpan = rawColSpan ? boundedNumber(rawColSpan, 1, ctx.budget.limits.cells, ctx) : 1;
        const rowSpan = rawRowSpan ? boundedNumber(rawRowSpan, 1, ctx.budget.limits.cells, ctx) : 1;
        if (colSpan > 1) output.colSpan = colSpan;
        if (rowSpan > 1) output.rowSpan = rowSpan;
      }
      if (!ctx.budget.addCells(repeat)) break;
      for (let copy = 0; copy < repeat; copy += 1) {
        ctx.budget.tick();
        cells.push(copy === 0 ? output : { ...output });
      }
    }
    rows.push(cells);
  }
  if (rows.length > 0) ctx.out.table(rows, headerRows, location('content.xml'));
}

function cellText(
  cell: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  trackedChanges: ReadonlyMap<string, TrackedChange>,
  ctx: ReadContext,
): string {
  // Paragraphs anywhere in the cell, nested tables and lists included, in document order (as DOCX).
  const pieces: string[] = [];
  const stack: XmlElement[] = [];
  for (let index = cell.children.length - 1; index >= 0; index -= 1) {
    const child = cell.children[index];
    if (child && typeof child !== 'string') stack.push(child);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const child = stack.pop()!;
    if (child.namespaceURI === TEXT_NS && (child.localName === 'p' || child.localName === 'h')) {
      pieces.push(trackedText(child, ctx, scopes, trackedChanges));
      continue;
    }
    if (!KNOWN_ODF_NAMESPACES.has(child.namespaceURI ?? '')) continue;
    for (let index = child.children.length - 1; index >= 0; index -= 1) {
      const nested = child.children[index];
      if (nested && typeof nested !== 'string') stack.push(nested);
    }
  }
  return pieces.filter(Boolean).join('\n');
}

function collectNestedTables(element: XmlElement, ctx: ReadContext): XmlElement[] {
  const output: XmlElement[] = [];
  const stack: XmlElement[] = [element];
  const visited = new Set<XmlElement>();
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') {
        if (child !== element && child.namespaceURI === TABLE_NS && child.localName === 'table')
          output.push(child);
        if (KNOWN_ODF_NAMESPACES.has(child.namespaceURI ?? '')) stack.push(child);
      }
    }
  }
  return output;
}

function addAnnotation(element: XmlElement, scopes: Map<XmlElement, OdfElement>, ctx: ReadContext): void {
  const paragraphs: string[] = [];
  const authorElement = directChild(element, DUBLIN_CORE_NS, 'creator', ctx);
  const author = authorElement ? directText(authorElement, ctx, true, scopes) : undefined;
  const stack: XmlElement[] = [element];
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (!KNOWN_ODF_NAMESPACES.has(current.namespaceURI ?? '')) continue;
    if (current.namespaceURI === TEXT_NS && current.localName === 'p')
      paragraphs.push(directText(current, ctx, true, scopes));
    else {
      for (let index = current.children.length - 1; index >= 0; index -= 1) {
        ctx.budget.tick();
        const child = current.children[index];
        if (child && typeof child !== 'string') stack.push(child);
      }
    }
  }
  const content = paragraphs.filter(Boolean).join('\n');
  if (content) ctx.out.note('comment', content, location('content.xml'), author);
}

function emitDescendantNotes(
  element: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  ctx: ReadContext,
): void {
  const stack: XmlElement[] = [];
  for (let index = element.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = element.children[index];
    if (child && typeof child !== 'string') stack.push(child);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (!KNOWN_ODF_NAMESPACES.has(current.namespaceURI ?? '')) continue;
    if (current.namespaceURI === ODF_OFFICE_NS && current.localName === 'annotation') {
      addAnnotation(current, scopes, ctx);
      continue;
    }
    if (current.namespaceURI === TEXT_NS && current.localName === 'note') {
      const body = directChild(current, TEXT_NS, 'note-body', ctx);
      if (body) {
        const textValue = directText(body, ctx, false, scopes);
        const role = attr(current, scopes, TEXT_NS, 'note-class', ctx) === 'endnote' ? 'endnote' : 'footnote';
        if (textValue) ctx.out.note(role, textValue, location('content.xml'));
      }
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
}

function detectExternalLinks(root: XmlElement, scopes: Map<XmlElement, OdfElement>, ctx: ReadContext): void {
  for (const item of odfElements(root, ctx.budget)) {
    ctx.budget.tick();
    const href = odfAttribute(item, XLINK_NS, 'href', ctx.budget);
    if (href && isExternal(href, ctx)) ctx.out.setFeature('hasExternalLinks');
  }
}

function isExternal(href: string, ctx: ReadContext): boolean {
  for (let index = 0; index < href.length; index += 1) {
    ctx.budget.tick();
    if (href.charCodeAt(index) === 58) return index > 0;
    if (href.charCodeAt(index) === 47) return href.charCodeAt(index + 1) === 47;
  }
  return false;
}

async function addImages(
  root: XmlElement,
  scopes: Map<XmlElement, OdfElement>,
  manifest: ReadonlyMap<string, { mediaType: string; encrypted: boolean }>,
  entries: ReadonlyMap<string, ZipEntry | null>,
  emitted: Set<string>,
  ctx: ReadContext,
  readPart: (path: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (!KNOWN_ODF_NAMESPACES.has(current.namespaceURI ?? '')) continue;
    if (current.namespaceURI === DRAW_NS && current.localName === 'frame') {
      const image = firstDescendant(current, DRAW_NS, 'image', ctx);
      if (image) {
        const href = attr(image, scopes, XLINK_NS, 'href', ctx);
        const title = firstDescendant(current, SVG_NS, 'title', ctx);
        const desc = firstDescendant(current, SVG_NS, 'desc', ctx);
        const alt = title
          ? directText(title, ctx, true, scopes)
          : desc
            ? directText(desc, ctx, true, scopes)
            : undefined;
        const ref = href && !isExternal(href, ctx) ? href : undefined;
        let mimeType: string | undefined;
        const width = dimension(attr(current, scopes, SVG_NS, 'width', ctx), ctx);
        const height = dimension(attr(current, scopes, SVG_NS, 'height', ctx), ctx);
        const entryMeta = ref ? manifest.get(ref) : undefined;
        const archiveEntry = ref ? entries.get(ref) : undefined;
        if (ref && entryMeta?.encrypted) throw new EncryptedError('password-required');
        if (ref && archiveEntry && archiveEntry !== null && archiveEntry.isEncrypted)
          throw new EncryptedError('password-required');
        if (
          ref &&
          entryMeta &&
          archiveEntry &&
          archiveEntry !== null &&
          !archiveEntry.isEncrypted &&
          !archiveEntry.isUnreadable
        ) {
          mimeType = entryMeta.mediaType || undefined;
          if (ctx.options.children !== 'skip' && !emitted.has(ref)) {
            emitted.add(ref);
            const child: {
              path: string;
              name: string;
              status: 'listed';
              sizeBytes: number;
              mimeType?: string;
              bytes?: Uint8Array;
            } = {
              path: ctx.path ? `${ctx.path}/${ref}` : ref,
              name: ref.slice(ref.lastIndexOf('/') + 1),
              status: 'listed',
              sizeBytes: archiveEntry.uncompressedSize,
            };
            if (mimeType) child.mimeType = mimeType;
            if (ctx.options.childBytes) child.bytes = await readPart(ref);
            ctx.out.addChild(child);
          }
        } else if (ref)
          warn(
            ctx,
            'UNREADABLE_PART',
            'ODT image part is missing or unreadable or absent from the manifest.',
            ref,
          );
        const output: { alt?: string; ref?: string; mimeType?: string; width?: number; height?: number } = {};
        if (alt) output.alt = alt;
        if (ref && entryMeta && archiveEntry && ctx.options.children !== 'skip') output.ref = ref;
        if (mimeType) output.mimeType = mimeType;
        if (width !== undefined) output.width = width;
        if (height !== undefined) output.height = height;
        ctx.out.image(output, location('content.xml'));
      }
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
}

function firstDescendant(
  root: XmlElement,
  ns: string,
  local: string,
  ctx: ReadContext,
): XmlElement | undefined {
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    ctx.budget.tick();
    const current = stack.pop()!;
    if (!KNOWN_ODF_NAMESPACES.has(current.namespaceURI ?? '')) continue;
    if (current !== root && current.namespaceURI === ns && current.localName === local) return current;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
  return undefined;
}

function dimension(value: string | undefined, ctx: ReadContext): number | undefined {
  if (!value) return undefined;
  let unitStart = value.length;
  while (unitStart > 0 && /[a-z]/i.test(value[unitStart - 1]!)) {
    ctx.budget.tick();
    unitStart -= 1;
  }
  const amount = Number(value.slice(0, unitStart));
  const unit = value.slice(unitStart).toLowerCase();
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const factor =
    unit === 'cm'
      ? 37.8
      : unit === 'mm'
        ? 3.78
        : unit === 'in'
          ? 96
          : unit === 'pt'
            ? 96 / 72
            : unit === 'px' || unit === ''
              ? 1
              : 0;
  if (factor === 0) return undefined;
  return Math.round(amount * factor);
}

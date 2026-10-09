import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import type { Block, Cell, ListItem, Location, Run } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { parseOdfManifest, parseOdfMetadata } from '../../odf/index.js';
import {
  ODF_OFFICE_NS,
  odfAttribute,
  odfElements,
  odfText,
  odfWarn,
  type OdfElement,
} from '../../odf/common.js';
import { parseXml } from '../../xml/index.js';
import type { XmlElement } from '../../xml/index.js';
import { openZip, type ZipArchive, type ZipEntry } from '../../zip/index.js';

type OdpBlock = Extract<Block, { kind: 'heading' | 'paragraph' | 'list' | 'table' | 'image' | 'note' }>;

const MIME_TYPE = 'application/vnd.oasis.opendocument.presentation';
const OFFICE_NS = ODF_OFFICE_NS;
const DRAW_NS = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const PRESENTATION_NS = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0';
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const SVG_NS = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

interface PagePosition {
  frame: XmlElement;
  item: OdfElement;
  x: number;
  y: number;
  ordinal: number;
}

interface ShapeVisit {
  element: XmlElement;
  item: OdfElement;
  x: number;
  y: number;
}

/** Reads OpenDocument Presentation packages into ordered slide sections. */
export const odpReader: Reader = {
  id: 'odp',
  mimeTypes: [MIME_TYPE],

  async read(ctx: ReadContext): Promise<void> {
    ctx.budget.tick();
    const zip = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const parts = indexParts(zip, ctx);
    const manifestEntry = parts.get('META-INF/manifest.xml');
    let manifest = {
      entries: new Map<string, { mediaType: string; encrypted: boolean }>(),
      hasEncryptedEntries: false,
    };
    if (manifestEntry) {
      const bytes = await readPart(zip, manifestEntry, ctx, false);
      if (bytes)
        manifest = parseOdfManifest(bytes, { budget: ctx.budget, warnings: ctx.warnings, path: ctx.path });
    }
    if (manifest.hasEncryptedEntries) throw new EncryptedError('password-required');

    const contentEntry = parts.get('content.xml');
    if (!contentEntry) throw new CorruptFileError('ODP presentation content is missing.');
    const contentBytes = await readPart(zip, contentEntry, ctx, true);
    if (!contentBytes) throw new CorruptFileError('ODP presentation content is unreadable.');
    const root = parseXml(contentBytes, { budget: ctx.budget, warnings: ctx.warnings, path: ctx.path });
    if (!root || root.namespaceURI !== OFFICE_NS || root.localName !== 'document-content') {
      throw new CorruptFileError('ODP presentation content is invalid.');
    }

    const scoped = odfElements(root, ctx.budget);
    const scopeByElement = new Map<XmlElement, OdfElement>();
    const pageElements = new Set<XmlElement>();
    for (const item of scoped) {
      ctx.budget.tick();
      scopeByElement.set(item.element, item);
      const externalHref = odfAttribute(item, XLINK_NS, 'href', ctx.budget);
      if (externalHref && isExternal(externalHref, ctx)) ctx.out.setFeature('hasExternalLinks');
    }
    // Only pages reached through the document's structural body/presentation
    // chain are slides. Extension subtrees can contain namespace-correct
    // elements that happen to reuse ODF names.
    for (const body of directElements(root, OFFICE_NS, 'body', ctx)) {
      for (const presentation of directElements(body, OFFICE_NS, 'presentation', ctx)) {
        for (const page of directElements(presentation, DRAW_NS, 'page', ctx)) pageElements.add(page);
      }
    }

    const metaEntry = parts.get('meta.xml');
    if (metaEntry) {
      const metadataBytes = await readPart(zip, metaEntry, ctx, false);
      if (metadataBytes) {
        ctx.out.setMetadata(
          parseOdfMetadata(
            metadataBytes,
            { budget: ctx.budget, warnings: ctx.warnings, path: ctx.path },
            {
              metadata: ctx.options.metadata,
            },
          ),
        );
      }
    }

    const childRefs = new Set<string>();
    let slide = 0;
    for (const item of scoped) {
      ctx.budget.tick();
      if (!pageElements.has(item.element)) continue;
      slide += 1;
      const page = item.element;
      const hiddenValue = odfAttribute(item, PRESENTATION_NS, 'visibility', ctx.budget);
      const hidden = hiddenValue === 'hidden';
      if (hidden) {
        ctx.warnings.add({
          code: 'HIDDEN_CONTENT',
          message: 'The presentation contains a hidden slide; its content is included.',
          ...(ctx.path ? { loc: { path: ctx.path } } : {}),
        });
      }
      const loc: Location = { slide, ...(ctx.path ? { path: ctx.path } : {}) };
      const shapes = collectFrames(page, scopeByElement, ctx);
      shapes.sort((left, right) => {
        ctx.budget.tick();
        return left.y - right.y || left.x - right.x || left.ordinal - right.ordinal;
      });

      let title: string | undefined;
      const blocks: OdpBlock[] = [];
      for (const shape of shapes) {
        ctx.budget.tick();
        const shapeItem = shape.item;
        const isTitle =
          odfAttribute(shapeItem, PRESENTATION_NS, 'class', ctx.budget) === 'title' && title === undefined;
        if (isTitle) {
          title = frameText(shape.frame, ctx, scopeByElement).trim() || undefined;
          continue;
        }
        collectBlocks(shape.frame, loc, ctx, scopeByElement, parts, manifest.entries, childRefs, blocks);
      }
      // Notes are content of the slide but remain distinct from its body blocks.
      for (const child of page.children) {
        ctx.budget.tick();
        if (
          typeof child !== 'string' &&
          child.namespaceURI === PRESENTATION_NS &&
          child.localName === 'notes'
        ) {
          const noteText = noteTextWithoutPersonalFields(child, ctx);
          if (noteText) blocks.push({ kind: 'note', role: 'speaker-notes', text: noteText, loc });
        }
      }

      ctx.out.openSection('slide', loc, title);
      for (const block of blocks) {
        ctx.budget.tick();
        emitBlock(ctx, block);
      }
      ctx.out.closeSection();
    }

    for (const ref of childRefs) {
      ctx.budget.tick();
      const entry = parts.get(ref);
      if (!entry) continue;
      const mediaType = manifest.entries.get(ref)?.mediaType || mediaTypeFor(ref, ctx);
      const slash = lastSlash(ref, ctx);
      const imageBytes = ctx.options.childBytes ? await readPart(zip, entry, ctx, false) : undefined;
      ctx.out.addChild({
        name: ref.slice(slash + 1),
        path: ctx.path ? `${ctx.path}/${ref}` : ref,
        status: 'listed',
        sizeBytes: entry.uncompressedSize,
        ...(imageBytes ? { bytes: imageBytes } : {}),
        ...(mediaType ? { mimeType: mediaType } : {}),
      });
    }
  },
};

function indexParts(zip: ZipArchive, ctx: ReadContext): Map<string, ZipEntry> {
  const parts = new Map<string, ZipEntry>();
  const duplicates = new Set<string>();
  for (const entry of zip.entries) {
    ctx.budget.tick();
    if (parts.has(entry.name)) {
      duplicates.add(entry.name);
      continue;
    }
    parts.set(entry.name, entry);
  }
  for (const name of duplicates) {
    ctx.budget.tick();
    parts.delete(name);
    warn(ctx, 'ODP package contains duplicate exact part names.');
  }
  return parts;
}

async function readPart(
  zip: ZipArchive,
  entry: ZipEntry,
  ctx: ReadContext,
  required: boolean,
): Promise<Uint8Array | undefined> {
  ctx.budget.tick();
  if (entry.isEncrypted) throw new EncryptedError('password-required');
  if (entry.isUnreadable) {
    warn(ctx, 'ODP package part is unreadable.');
    return undefined;
  }
  const bytes = await zip.read(entry);
  ctx.budget.tick();
  if (!bytes) {
    if (required) warn(ctx, 'ODP presentation content is unreadable.');
    else warn(ctx, 'ODP package part is unreadable.');
    return undefined;
  }
  return bytes;
}

function collectFrames(
  page: XmlElement,
  scopeByElement: Map<XmlElement, OdfElement>,
  ctx: ReadContext,
): PagePosition[] {
  const frames: PagePosition[] = [];
  const pending: ShapeVisit[] = [];
  for (let index = page.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = page.children[index];
    if (child && typeof child !== 'string')
      pending.push({ element: child, item: scopeByElement.get(child)!, x: 0, y: 0 });
  }
  let ordinal = 0;
  while (pending.length > 0) {
    ctx.budget.tick();
    const current = pending.pop()!;
    if (current.element.namespaceURI === PRESENTATION_NS && current.element.localName === 'notes') continue;
    if (
      current.element.namespaceURI === DRAW_NS &&
      (current.element.localName === 'frame' || current.element.localName === 'custom-shape')
    ) {
      const x = current.x + coordinate(odfAttribute(current.item, SVG_NS, 'x', ctx.budget), ctx);
      const y = current.y + coordinate(odfAttribute(current.item, SVG_NS, 'y', ctx.budget), ctx);
      frames.push({ frame: current.element, item: current.item, x, y, ordinal: ordinal++ });
      continue;
    }
    if (current.element.namespaceURI === DRAW_NS && current.element.localName === 'g') {
      const x = current.x + coordinate(odfAttribute(current.item, SVG_NS, 'x', ctx.budget), ctx);
      const y = current.y + coordinate(odfAttribute(current.item, SVG_NS, 'y', ctx.budget), ctx);
      for (let index = current.element.children.length - 1; index >= 0; index -= 1) {
        ctx.budget.tick();
        const child = current.element.children[index];
        if (child && typeof child !== 'string') {
          const childItem = scopeByElement.get(child);
          if (childItem) pending.push({ element: child, item: childItem, x, y });
        }
      }
      continue;
    }
    // Continue through shapes such as draw:custom-shape, but never through an
    // already-collected frame where nested image/text elements would reorder it.
    for (let index = current.element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.element.children[index];
      if (child && typeof child !== 'string') {
        const childItem = scopeByElement.get(child);
        if (childItem)
          pending.push({
            element: child,
            item: childItem,
            x: current.x,
            y: current.y,
          });
      }
    }
  }
  return frames;
}

function directElements(
  parent: XmlElement,
  namespace: string,
  localName: string,
  ctx: ReadContext,
): XmlElement[] {
  const elements: XmlElement[] = [];
  for (const child of parent.children) {
    ctx.budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === namespace && child.localName === localName)
      elements.push(child);
  }
  return elements;
}

function coordinate(value: string | undefined, ctx: ReadContext): number {
  if (value === undefined || value.length === 0) return 0;
  let split = 0;
  while (split < value.length) {
    ctx.budget.tick();
    const code = value.charCodeAt(split);
    if (!(
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 45 ||
      code === 46 ||
      code === 69 ||
      code === 101
    ))
      break;
    split += 1;
  }
  const amount = Number(value.slice(0, split));
  if (!Number.isFinite(amount)) return 0;
  const unit = value.slice(split);
  switch (unit) {
    case 'cm':
      return amount * (96 / 2.54);
    case 'mm':
      return amount * (96 / 25.4);
    case 'in':
      return amount * 96;
    case 'pt':
      return amount * (96 / 72);
    case 'pc':
      return amount * 16;
    case 'px':
    case '':
      return amount;
    default:
      return 0;
  }
}

function collectBlocks(
  root: XmlElement,
  loc: Location,
  ctx: ReadContext,
  scopeByElement: Map<XmlElement, OdfElement>,
  parts: Map<string, ZipEntry>,
  manifest: ReadonlyMap<string, { mediaType: string; encrypted: boolean }>,
  childRefs: Set<string>,
  output: OdpBlock[],
): void {
  const stack: XmlElement[] = [];
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = root.children[index];
    if (child && typeof child !== 'string') stack.push(child);
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const element = stack.pop()!;
    const ns = element.namespaceURI;
    if (ns === PRESENTATION_NS && element.localName === 'notes') continue;
    if (ns === DRAW_NS && element.localName === 'image') {
      const frameItem = scopeByElement.get(root);
      const item = scopeByElement.get(element);
      if (item) {
        const href = odfAttribute(item, XLINK_NS, 'href', ctx.budget);
        const external = href !== undefined && isExternal(href, ctx);
        if (external) ctx.out.setFeature('hasExternalLinks');
        const ref =
          href !== undefined && !external && safePartKey(href, ctx) && parts.has(href) ? href : undefined;
        if (ref) childRefs.add(ref);
        const desc = frameItem ? directText(frameItem, SVG_NS, 'desc', ctx) : undefined;
        const title = frameItem ? directText(frameItem, SVG_NS, 'title', ctx) : undefined;
        const width = frameItem
          ? dimension(odfAttribute(frameItem, SVG_NS, 'width', ctx.budget), ctx)
          : undefined;
        const height = frameItem
          ? dimension(odfAttribute(frameItem, SVG_NS, 'height', ctx.budget), ctx)
          : undefined;
        const mimeType = ref ? manifest.get(ref)?.mediaType || mediaTypeFor(ref, ctx) : undefined;
        output.push({
          kind: 'image',
          ...(desc || title ? { alt: desc || title } : {}),
          ...(mimeType ? { mimeType } : {}),
          ...(ref ? { ref } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          loc,
        });
      }
      continue;
    }
    if (ns === TEXT_NS && element.localName === 'p') {
      const runs = inlineRuns(element, ctx, scopeByElement);
      const textParts: string[] = [];
      for (const run of runs) {
        ctx.budget.tick();
        textParts.push(run.text);
      }
      const text = joinParts(textParts, '', ctx);
      if (text.trim().length > 0)
        output.push({ kind: 'paragraph', text, ...(ctx.options.runs ? { runs } : {}), loc });
      continue;
    }
    if (ns === TEXT_NS && element.localName === 'h') {
      const item = scopeByElement.get(element);
      const levelValue = item ? odfAttribute(item, TEXT_NS, 'outline-level', ctx.budget) : undefined;
      const level = parseLevel(levelValue, ctx);
      const text = textWithin(element, ctx, scopeByElement);
      if (text) output.push({ kind: 'heading', level, text, loc });
      continue;
    }
    if (ns === TEXT_NS && element.localName === 'list') {
      output.push(parseList(element, ctx, scopeByElement, loc));
      continue;
    }
    if (ns === TABLE_NS && element.localName === 'table') {
      output.push(parseTable(element, ctx, scopeByElement, loc));
      continue;
    }
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
  }
}

function parseList(
  root: XmlElement,
  ctx: ReadContext,
  scopes: Map<XmlElement, OdfElement>,
  loc: Location,
): OdpBlock {
  const items: ListItem[] = [];
  const pending: Array<{ element: XmlElement; target: ListItem[] }> = [];
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = root.children[index];
    if (
      child &&
      typeof child !== 'string' &&
      child.namespaceURI === TEXT_NS &&
      child.localName === 'list-item'
    )
      pending.push({ element: child, target: items });
  }
  while (pending.length > 0) {
    ctx.budget.tick();
    const { element, target } = pending.pop()!;
    const item: ListItem = { text: '' };
    const texts: string[] = [];
    const nested: XmlElement[] = [];
    const stack: XmlElement[] = [];
    for (let index = element.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = element.children[index];
      if (child && typeof child !== 'string') stack.push(child);
    }
    while (stack.length > 0) {
      ctx.budget.tick();
      const current = stack.pop()!;
      if (current.namespaceURI === TEXT_NS && current.localName === 'list') {
        nested.push(current);
      } else if (
        current.namespaceURI === TEXT_NS &&
        (current.localName === 'p' || current.localName === 'h')
      ) {
        texts.push(textWithin(current, ctx, scopes));
      } else {
        for (let index = current.children.length - 1; index >= 0; index -= 1) {
          ctx.budget.tick();
          const child = current.children[index];
          if (child && typeof child !== 'string') stack.push(child);
        }
      }
    }
    const retainedTexts: string[] = [];
    for (const text of texts) {
      ctx.budget.tick();
      if (text) retainedTexts.push(text);
    }
    item.text = joinParts(retainedTexts, '\n', ctx);
    target.push(item);
    for (let listIndex = nested.length - 1; listIndex >= 0; listIndex -= 1) {
      ctx.budget.tick();
      const childItems = item.items ?? (item.items = []);
      const list = nested[listIndex]!;
      for (let index = list.children.length - 1; index >= 0; index -= 1) {
        ctx.budget.tick();
        const child = list.children[index];
        if (
          child &&
          typeof child !== 'string' &&
          child.namespaceURI === TEXT_NS &&
          child.localName === 'list-item'
        )
          pending.push({ element: child, target: childItems });
      }
    }
  }
  return { kind: 'list', ordered: false, items, loc };
}

function parseTable(
  root: XmlElement,
  ctx: ReadContext,
  scopes: Map<XmlElement, OdfElement>,
  loc: Location,
): Extract<Block, { kind: 'table' }> {
  const rows: Cell[][] = [];
  let headerRows = 0;
  const pending: Array<{ element: XmlElement; header: boolean }> = [];
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = root.children[index];
    if (child && typeof child !== 'string') pending.push({ element: child, header: false });
  }
  while (pending.length > 0) {
    ctx.budget.tick();
    const frame = pending.pop()!;
    const row = frame.element;
    if (
      row.namespaceURI === TABLE_NS &&
      (row.localName === 'table-row' || row.localName === 'table-header-rows')
    ) {
      if (row.localName === 'table-header-rows') {
        for (let index = row.children.length - 1; index >= 0; index -= 1) {
          ctx.budget.tick();
          const child = row.children[index];
          if (child && typeof child !== 'string') pending.push({ element: child, header: true });
        }
        continue;
      }
      const cells: Cell[] = [];
      for (const cellElement of row.children) {
        ctx.budget.tick();
        if (typeof cellElement === 'string' || cellElement.namespaceURI !== TABLE_NS) continue;
        if (cellElement.localName !== 'table-cell' && cellElement.localName !== 'covered-table-cell')
          continue;
        if (!ctx.budget.addCells(1)) {
          if (cells.length > 0) {
            rows.push(cells);
            if (frame.header) headerRows += 1;
          }
          return { kind: 'table', rows, headerRows, loc };
        }
        const item = scopes.get(cellElement);
        const text =
          cellElement.localName === 'covered-table-cell' ? '' : textInParagraphs(cellElement, ctx, scopes);
        const colSpan = item
          ? positiveSpan(odfAttribute(item, TABLE_NS, 'number-columns-spanned', ctx.budget), ctx)
          : undefined;
        const rowSpan = item
          ? positiveSpan(odfAttribute(item, TABLE_NS, 'number-rows-spanned', ctx.budget), ctx)
          : undefined;
        cells.push({
          text,
          ...(colSpan && colSpan > 1 ? { colSpan } : {}),
          ...(rowSpan && rowSpan > 1 ? { rowSpan } : {}),
        });
      }
      rows.push(cells);
      if (frame.header) headerRows += 1;
      continue;
    }
    for (let index = row.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = row.children[index];
      if (child && typeof child !== 'string') pending.push({ element: child, header: frame.header });
    }
  }
  return { kind: 'table', rows, headerRows, loc };
}

function textInParagraphs(root: XmlElement, ctx: ReadContext, scopes: Map<XmlElement, OdfElement>): string {
  const pieces: string[] = [];
  const pending: XmlElement[] = [];
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = root.children[index];
    if (child && typeof child !== 'string') pending.push(child);
  }
  while (pending.length > 0) {
    ctx.budget.tick();
    const current = pending.pop()!;
    if (current.namespaceURI === TEXT_NS && current.localName === 'p') {
      pieces.push(textWithin(current, ctx, scopes));
      continue;
    }
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child && typeof child !== 'string') pending.push(child);
    }
  }
  return joinParts(pieces, '\n', ctx);
}

function inlineRuns(root: XmlElement, ctx: ReadContext, scopes: Map<XmlElement, OdfElement>): Run[] {
  const runs: Run[] = [];
  const stack: Array<{ value: XmlElement | string; href?: string }> = [];
  for (let index = root.children.length - 1; index >= 0; index -= 1) {
    ctx.budget.tick();
    const child = root.children[index];
    if (child !== undefined) stack.push({ value: child });
  }
  while (stack.length > 0) {
    ctx.budget.tick();
    const frame = stack.pop()!;
    if (typeof frame.value === 'string') {
      if (frame.value.length > 0) {
        const previous = runs.at(-1);
        if (previous && previous.href === frame.href) previous.text += frame.value;
        else runs.push({ text: frame.value, ...(frame.href ? { href: frame.href } : {}) });
      }
      continue;
    }
    let href = frame.href;
    if (frame.value.namespaceURI === TEXT_NS && frame.value.localName === 'a') {
      const item = scopes.get(frame.value);
      href = item ? odfAttribute(item, XLINK_NS, 'href', ctx.budget) : undefined;
      if (href && isExternal(href, ctx)) ctx.out.setFeature('hasExternalLinks');
    }
    for (let index = frame.value.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = frame.value.children[index];
      if (child !== undefined) stack.push({ value: child, ...(href ? { href } : {}) });
    }
  }
  return runs;
}

function frameText(root: XmlElement, ctx: ReadContext, scopes: Map<XmlElement, OdfElement>): string {
  return textInParagraphs(root, ctx, scopes);
}

function joinParts(parts: readonly string[], separator: string, ctx: ReadContext): string {
  let output = '';
  for (let index = 0; index < parts.length; index += 1) {
    ctx.budget.tick();
    if (index > 0) output += separator;
    output += parts[index]!;
  }
  return output;
}

function textWithin(root: XmlElement, ctx: ReadContext, scopes: Map<XmlElement, OdfElement>): string {
  void scopes;
  return odfText(root, ctx.budget);
}

function noteTextWithoutPersonalFields(root: XmlElement, ctx: ReadContext): string {
  const pieces: string[] = [];
  const pending: Array<XmlElement | string> = [root];
  while (pending.length > 0) {
    ctx.budget.tick();
    const current = pending.pop()!;
    if (typeof current === 'string') {
      pieces.push(current);
      continue;
    }
    if (
      current.namespaceURI === TEXT_NS &&
      (current.localName === 'creator' ||
        current.localName === 'author' ||
        current.localName === 'initial-creator')
    )
      continue;
    for (let index = current.children.length - 1; index >= 0; index -= 1) {
      ctx.budget.tick();
      const child = current.children[index];
      if (child !== undefined) pending.push(child);
    }
  }
  return joinParts(pieces, '', ctx);
}

function directText(
  item: OdfElement,
  namespace: string,
  localName: string,
  ctx: ReadContext,
): string | undefined {
  for (const child of item.element.children) {
    ctx.budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === namespace && child.localName === localName) {
      const text = odfText(child, ctx.budget);
      if (text) return text;
    }
  }
  return undefined;
}

function positiveSpan(raw: string | undefined, ctx: ReadContext): number | undefined {
  if (!raw) return undefined;
  let value = 0;
  for (let index = 0; index < raw.length; index += 1) {
    ctx.budget.tick();
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    value = value * 10 + code - 48;
    if (!Number.isSafeInteger(value) || value > 10_000) return undefined;
  }
  return value > 0 ? value : undefined;
}

function parseLevel(raw: string | undefined, ctx: ReadContext): 1 | 2 | 3 | 4 | 5 | 6 {
  if (raw === undefined || raw.length === 0) return 1;
  let parsed = 0;
  for (let index = 0; index < raw.length; index += 1) {
    ctx.budget.tick();
    const code = raw.charCodeAt(index);
    if (code < 48 || code > 57) return 1;
    parsed = parsed * 10 + code - 48;
  }
  return parsed >= 1 && parsed <= 6 ? (parsed as 1 | 2 | 3 | 4 | 5 | 6) : 1;
}

function dimension(raw: string | undefined, ctx: ReadContext): number | undefined {
  if (raw === undefined) return undefined;
  const px = coordinate(raw, ctx);
  if (!(px > 0) || !Number.isFinite(px)) return undefined;
  return Math.round(px);
}

function safePartKey(value: string, ctx: ReadContext): boolean {
  if (value.length === 0) return false;
  let segmentStart = 0;
  for (let index = 0; index <= value.length; index += 1) {
    ctx.budget.tick();
    if (index < value.length) {
      const code = value.charCodeAt(index);
      if (code === 92) return false;
      if (code !== 47) continue;
    }
    const segment = value.slice(segmentStart, index);
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    segmentStart = index + 1;
  }
  for (let index = 0; index + 2 < value.length; index += 1) {
    ctx.budget.tick();
    if (value.charCodeAt(index) !== 37) continue;
    const first = hexValue(value.charCodeAt(index + 1));
    const second = hexValue(value.charCodeAt(index + 2));
    if (first < 0 || second < 0) continue;
    const decoded = first * 16 + second;
    if (decoded === 0x2e || decoded === 0x2f || decoded === 0x5c) return false;
  }
  return true;
}

function isExternal(value: string, ctx: ReadContext): boolean {
  if (value.length >= 2 && value.charCodeAt(0) === 47 && value.charCodeAt(1) === 47) return true;
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code === 58) return index > 0;
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (!(alpha || (index > 0 && (digit || code === 43 || code === 45 || code === 46)))) return false;
  }
  return false;
}

function mediaTypeFor(name: string, ctx: ReadContext): string | undefined {
  let dot = -1;
  for (let index = 0; index < name.length; index += 1) {
    ctx.budget.tick();
    if (name.charCodeAt(index) === 46) dot = index;
  }
  let extension = '';
  for (let index = dot + 1; index < name.length; index += 1) {
    ctx.budget.tick();
    const code = name.charCodeAt(index);
    extension += String.fromCharCode(code >= 65 && code <= 90 ? code + 32 : code);
  }
  switch (extension) {
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'webp':
      return 'image/webp';
    case 'tif':
    case 'tiff':
      return 'image/tiff';
    default:
      return undefined;
  }
}

function lastSlash(value: string, ctx: ReadContext): number {
  let result = -1;
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    if (value.charCodeAt(index) === 47) result = index;
  }
  return result;
}

function emitBlock(ctx: ReadContext, block: OdpBlock): void {
  switch (block.kind) {
    case 'heading':
      ctx.out.heading(block.level, block.text, block.loc);
      break;
    case 'paragraph':
      ctx.out.paragraph(block.text, block.loc, block.runs);
      break;
    case 'list':
      ctx.out.list(block.ordered, block.items, block.loc);
      break;
    case 'table':
      ctx.out.table(block.rows, block.headerRows, block.loc, block.caption);
      break;
    case 'image':
      ctx.out.image(block, block.loc);
      break;
    case 'note':
      ctx.out.note(block.role, block.text, block.loc, block.author);
      break;
  }
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function warn(ctx: ReadContext, message: string): void {
  odfWarn(ctx, 'UNREADABLE_PART', message);
}

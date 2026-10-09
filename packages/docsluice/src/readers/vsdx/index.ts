import type { ReadContext, Reader } from '../../core/reader.js';
import type { XmlContext } from '../../xml/index.js';
import { parseXml } from '../../xml/index.js';
import type { XmlElement } from '../../xml/index.js';
import {
  OoxmlParts,
  readContentTypes,
  readProperties,
  readRelationships,
  scanFeatures,
} from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import { openZip } from '../../zip/index.js';

const MIME_TYPE = 'application/vnd.ms-visio.drawing';
const CORE = 'http://schemas.microsoft.com/office/visio/2011/1/core';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const VISIO_REL = 'http://schemas.microsoft.com/visio/2010/relationships/';
const DOC_CONTENT_TYPE = 'application/vnd.ms-visio.drawing.main+xml';
const PAGES_CONTENT_TYPE = 'application/vnd.ms-visio.pages+xml';
const PAGE_CONTENT_TYPE = 'application/vnd.ms-visio.page+xml';

function warn(ctx: ReadContext): void {
  ctx.warnings.add({
    code: 'UNREADABLE_PART',
    message: 'A Visio package part could not be read.',
    ...(ctx.path ? { loc: { path: ctx.path } } : {}),
  });
}

function xmlContext(ctx: ReadContext): XmlContext {
  return { budget: ctx.budget, warnings: ctx.warnings, ...(ctx.path ? { path: ctx.path } : {}) };
}

function elements(parent: XmlElement, ctx: ReadContext, localName?: string): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of parent.children) {
    ctx.budget.tick();
    if (
      typeof child !== 'string' &&
      child.namespaceURI === CORE &&
      (localName === undefined || child.localName === localName)
    )
      found.push(child);
  }
  return found;
}

async function xmlPart(
  parts: OoxmlParts,
  path: string,
  localName: string,
  ctx: ReadContext,
): Promise<XmlElement | undefined> {
  const bytes = await parts.read(path);
  ctx.budget.tick();
  if (!bytes) {
    warn(ctx);
    return undefined;
  }
  const root = parseXml(bytes, xmlContext(ctx));
  if (!root || root.namespaceURI !== CORE || root.localName !== localName) {
    warn(ctx);
    return undefined;
  }
  return root;
}

function relationshipOfType(
  relationships: Map<string, OoxmlRelationship>,
  type: string,
  ctx: ReadContext,
): OoxmlRelationship | undefined {
  let found: OoxmlRelationship | undefined;
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.type !== type || relationship.external || !relationship.part) continue;
    if (found) {
      warn(ctx);
      return undefined;
    }
    found = relationship;
  }
  if (!found) warn(ctx);
  return found;
}

function isRelationshipIdAttribute(
  attribute: string,
  ancestors: readonly XmlElement[],
  ctx: ReadContext,
): boolean {
  let colon = -1;
  for (let index = 0; index < attribute.length; index++) {
    ctx.budget.tick();
    if (attribute.charCodeAt(index) === 0x3a) {
      colon = index;
      break;
    }
  }
  if (
    colon <= 0 ||
    attribute.length - colon !== 3 ||
    attribute.charCodeAt(colon + 1) !== 0x69 ||
    attribute.charCodeAt(colon + 2) !== 0x64
  )
    return false;
  const prefix = attribute.slice(0, colon);
  for (let index = ancestors.length - 1; index >= 0; index--) {
    ctx.budget.tick();
    const binding = ancestors[index]!.attrs.get(`xmlns:${prefix}`);
    if (binding !== undefined) return binding === OFFICE_REL;
  }
  return false;
}

function pageRelationshipId(page: XmlElement, root: XmlElement, ctx: ReadContext): string | undefined {
  const relations = elements(page, ctx, 'Rel');
  if (relations.length !== 1) {
    warn(ctx);
    return undefined;
  }
  const relation = relations[0]!;
  const ids: string[] = [];
  for (const [key, value] of relation.attrs) {
    ctx.budget.tick();
    if (key.startsWith('xmlns')) continue;
    if (isRelationshipIdAttribute(key, [root, page, relation], ctx) && value) ids.push(value);
  }
  if (ids.length !== 1) {
    warn(ctx);
    return undefined;
  }
  return ids[0];
}

function hasResourceTruncation(ctx: ReadContext): boolean {
  for (const warning of ctx.warnings.warnings) {
    ctx.budget.tick();
    if (warning.code === 'TRUNCATED') return true;
  }
  return false;
}

function textContent(text: XmlElement, ctx: ReadContext): string | undefined {
  const chunks: string[] = [];
  let stagedChars = 0;
  const append = (chunk: string): boolean => {
    if (!ctx.budget.checkOutputChars(stagedChars + chunk.length)) return false;
    stagedChars += chunk.length;
    chunks.push(chunk);
    return true;
  };
  for (const child of text.children) {
    ctx.budget.tick();
    if (typeof child === 'string') {
      if (!append(child)) return undefined;
      continue;
    }
    if (child.namespaceURI !== CORE || !['cp', 'pp', 'tp', 'fld'].includes(child.localName)) {
      warn(ctx);
      continue;
    }
    if (child.localName !== 'fld') {
      if (child.children.length > 0) warn(ctx);
      continue;
    }
    for (const fieldChild of child.children) {
      ctx.budget.tick();
      if (typeof fieldChild !== 'string') {
        warn(ctx);
        continue;
      }
      if (!append(fieldChild)) return undefined;
    }
  }
  return chunks.join('');
}

function canonicalShapeId(value: string | undefined, ctx: ReadContext): string | undefined {
  if (!value || value.length > 10) return undefined;
  let number = 0;
  for (let index = 0; index < value.length; index++) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    number = number * 10 + code - 48;
    if (number > 0xffff_ffff) return undefined;
  }
  return number >= 4 ? String(number) : undefined;
}

function trimAttribute(value: string | undefined, ctx: ReadContext): string | undefined {
  if (value === undefined) return undefined;
  if (!ctx.budget.checkOutputChars(value.length)) return undefined;
  let start = 0;
  let end = value.length;
  while (start < end && isSpace(value.charCodeAt(start))) {
    ctx.budget.tick();
    start += 1;
  }
  while (end > start && isSpace(value.charCodeAt(end - 1))) {
    ctx.budget.tick();
    end -= 1;
  }
  return start < end ? value.slice(start, end) : undefined;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

interface ShapeFrame {
  shapes: XmlElement[];
  index: number;
  seenIds: Set<string>;
  entered: boolean;
}

function readShapes(
  shapes: readonly XmlElement[],
  loc: { page: number; pageLabel: string },
  ctx: ReadContext,
): boolean {
  const stack: ShapeFrame[] = [];
  const push = (items: XmlElement[]): boolean => {
    const entered = ctx.budget.enterDepth('xml');
    if (!entered) {
      ctx.budget.exitDepth('xml');
      return false;
    }
    stack.push({ shapes: items, index: 0, seenIds: new Set(), entered: true });
    return true;
  };
  const roots: XmlElement[] = [];
  for (const shape of shapes) {
    ctx.budget.tick();
    roots.push(shape);
  }
  if (!push(roots)) return false;
  try {
    while (stack.length > 0) {
      ctx.budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.index >= frame.shapes.length) {
        stack.pop();
        if (frame.entered) ctx.budget.exitDepth('xml');
        continue;
      }
      const shape = frame.shapes[frame.index++]!;
      ctx.budget.tick();
      if (shape.localName !== 'Shape') {
        warn(ctx);
        continue;
      }
      const id = canonicalShapeId(shape.attrs.get('ID'), ctx);
      if (!id || frame.seenIds.has(id)) {
        warn(ctx);
        continue;
      }
      frame.seenIds.add(id);

      for (const text of elements(shape, ctx, 'Text')) {
        ctx.budget.tick();
        const value = textContent(text, ctx);
        if (value === undefined) return false;
        if (value.length > 0 && !ctx.out.paragraph(value, loc)) return false;
      }

      const childContainers = elements(shape, ctx, 'Shapes');
      for (let index = childContainers.length - 1; index >= 0; index--) {
        ctx.budget.tick();
        const nested = elements(childContainers[index]!, ctx, 'Shape');
        if (nested.length > 0 && !push(nested)) return false;
      }
    }
  } finally {
    while (stack.length > 0) {
      try {
        ctx.budget.tick();
      } catch {
        // Preserve the active parse/cancellation error while balancing all entered depths.
      }
      const frame = stack.pop()!;
      if (frame.entered) ctx.budget.exitDepth('xml');
    }
  }
  return true;
}

async function readPage(
  parts: OoxmlParts,
  pagePart: string,
  pageIndex: number,
  pageLabel: string,
  types: Awaited<ReturnType<typeof readContentTypes>>,
  ctx: ReadContext,
): Promise<void> {
  const loc = { page: pageIndex, pageLabel, ...(ctx.path ? { path: ctx.path } : {}) };
  if (types.mimeType(pagePart) !== PAGE_CONTENT_TYPE) {
    warn(ctx);
    return;
  }
  const page = await xmlPart(parts, pagePart, 'PageContents', ctx);
  ctx.budget.tick();
  if (!page || hasResourceTruncation(ctx)) return;
  const opened = ctx.out.openSection('page', loc, pageLabel);
  if (!opened) {
    if (hasResourceTruncation(ctx)) ctx.out.closeSection();
    return;
  }
  try {
    for (const container of elements(page, ctx, 'Shapes')) {
      ctx.budget.tick();
      if (!readShapes(elements(container, ctx, 'Shape'), loc, ctx)) break;
    }
  } finally {
    ctx.out.closeSection();
  }
}

async function readVsdx(ctx: ReadContext): Promise<void> {
  ctx.budget.tick();
  const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
  const xml = xmlContext(ctx);
  const parts = new OoxmlParts(archive, xml);
  const types = await readContentTypes(parts, xml);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;

  if (ctx.options.metadata !== false) {
    const properties = await readProperties(parts, xml, true);
    ctx.budget.tick();
    if (hasResourceTruncation(ctx)) return;
    ctx.out.setMetadata(properties);
  }
  const features = await scanFeatures(parts, archive, xml);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  if (features.hasMacros) ctx.out.setFeature('hasMacros');
  ctx.budget.tick();
  if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
  ctx.budget.tick();
  if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
  ctx.budget.tick();
  if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
  ctx.budget.tick();
  if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');

  const rootRelationships = await readRelationships(parts, '', xml);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  const documentRelationship = relationshipOfType(rootRelationships, `${VISIO_REL}document`, ctx);
  if (!documentRelationship?.part || types.mimeType(documentRelationship.part) !== DOC_CONTENT_TYPE) {
    warn(ctx);
    return;
  }
  const document = await xmlPart(parts, documentRelationship.part, 'VisioDocument', ctx);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  if (!document) return;

  const documentRelationships = await readRelationships(parts, documentRelationship.part, xml);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  const pagesRelationship = relationshipOfType(documentRelationships, `${VISIO_REL}pages`, ctx);
  if (!pagesRelationship?.part || types.mimeType(pagesRelationship.part) !== PAGES_CONTENT_TYPE) {
    warn(ctx);
    return;
  }
  const pagesRoot = await xmlPart(parts, pagesRelationship.part, 'Pages', ctx);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  if (!pagesRoot) return;
  const pagesRelationships = await readRelationships(parts, pagesRelationship.part, xml);
  ctx.budget.tick();
  if (hasResourceTruncation(ctx)) return;
  let pageIndex = 0;
  for (const page of elements(pagesRoot, ctx, 'Page')) {
    ctx.budget.tick();
    if (!ctx.budget.canRead || hasResourceTruncation(ctx)) return;
    pageIndex += 1;
    const name = trimAttribute(page.attrs.get('Name'), ctx);
    if (hasResourceTruncation(ctx)) return;
    const universalName = name ?? trimAttribute(page.attrs.get('NameU'), ctx);
    if (hasResourceTruncation(ctx)) return;
    const pageLabel = universalName ?? `Page ${pageIndex}`;
    const relationshipId = pageRelationshipId(page, pagesRoot, ctx);
    const relationship = relationshipId ? pagesRelationships.get(relationshipId) : undefined;
    if (
      !relationship ||
      relationship.external ||
      !relationship.part ||
      relationship.type !== `${VISIO_REL}page`
    ) {
      warn(ctx);
      continue;
    }
    await readPage(parts, relationship.part, pageIndex, pageLabel, types, ctx);
    ctx.budget.tick();
    if (hasResourceTruncation(ctx)) return;
  }
}

export const vsdxReader: Reader = {
  id: 'vsdx',
  mimeTypes: [MIME_TYPE],
  async read(ctx): Promise<void> {
    await readVsdx(ctx);
  },
};

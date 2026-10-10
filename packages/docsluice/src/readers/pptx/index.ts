import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import {
  OoxmlParts,
  readContentTypes,
  readProperties,
  readRelationships,
  scanFeatures,
} from '../../ooxml/index.js';
import type { OoxmlRelationship } from '../../ooxml/index.js';
import { openZip } from '../../zip/index.js';
import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { parseDiagramData } from './diagram.js';
import { autoNumberMarker, bulletMarker, nestItems } from './lists.js';
import type { FlatItem } from './lists.js';
import { namespacedAttribute, namespaceScope, P_NS, R_NS, REL_BASE } from './presentationml.js';
import { parseSlide } from './slide.js';
import type { PptxPlaceholder, PptxShape, PptxSlideContent } from './slide.js';

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
/** Presentation part content types for decks, shows, templates and their macro-enabled forms. */
const MAIN_PART_TYPES: ReadonlySet<string> = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
]);
const TITLE_TYPES: ReadonlySet<string> = new Set(['title', 'ctrTitle']);
/** Generated placeholder text (date, slide number, header) is not slide content. */
const SKIPPED_TYPES: ReadonlySet<string> = new Set(['dt', 'sldNum', 'hdr']);
/** Placeholders whose paragraphs are bulleted unless a paragraph says otherwise. */
const BULLETED_TYPES: ReadonlySet<string> = new Set(['body', 'obj']);

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

function relationshipOfType(
  relationships: ReadonlyMap<string, OoxmlRelationship>,
  type: string,
  ctx: XmlContext,
): OoxmlRelationship | undefined {
  for (const relationship of relationships.values()) {
    ctx.budget.tick();
    if (relationship.type === `${REL_BASE}${type}` && !relationship.external && relationship.part)
      return relationship;
  }
  return undefined;
}

/** Slide relationship ids in `p:sldIdLst` order (PPT-1). */
function slideOrder(input: Uint8Array, ctx: XmlContext): string[] {
  const ids: string[] = [];
  const names: Array<string | undefined> = [];
  const scopes: Map<string, string>[] = [];
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        scopes.push(namespaceScope(attrs, ctx.budget));
        const local = info.namespaceURI === P_NS ? info.localName : undefined;
        const parent = names.at(-1);
        names.push(local);
        if (local === 'sldId' && parent === 'sldIdLst' && names.length === 3) {
          const id = namespacedAttribute(attrs, 'id', R_NS, scopes, ctx.budget);
          if (id !== undefined) ids.push(id);
        }
      },
      onClose() {
        ctx.budget.tick();
        names.pop();
        scopes.pop();
      },
    },
    ctx,
  );
  return ids;
}

function placeholderKind(type: string): string {
  if (TITLE_TYPES.has(type)) return 'title';
  return BULLETED_TYPES.has(type) ? 'body' : type;
}

/** The layout or master shape a placeholder inherits its position from: same `idx`, else same type. */
function inheritedShape(
  placeholder: PptxPlaceholder,
  sources: readonly PptxSlideContent[],
  ctx: XmlContext,
): PptxShape | undefined {
  const kind = placeholderKind(placeholder.type);
  for (const source of sources) {
    let byType: PptxShape | undefined;
    for (const shape of source.shapes) {
      ctx.budget.tick();
      if (!shape.placeholder || shape.y === undefined) continue;
      if (placeholder.idx !== undefined && shape.placeholder.idx === placeholder.idx) return shape;
      if (!byType && placeholderKind(shape.placeholder.type) === kind) byType = shape;
    }
    if (byType) return byType;
  }
  return undefined;
}

/** The first title placeholder with text: its paragraphs joined by spaces (PPT-2). */
function slideTitle(
  shapes: readonly PptxShape[],
  ctx: XmlContext,
): { shape: PptxShape; title: string } | undefined {
  for (const shape of shapes) {
    ctx.budget.tick();
    if (!shape.placeholder || !TITLE_TYPES.has(shape.placeholder.type)) continue;
    const texts: string[] = [];
    for (const paragraph of shape.paragraphs) {
      ctx.budget.tick();
      const text = paragraph.text.trim();
      if (text.length > 0) texts.push(text);
    }
    if (texts.length > 0) return { shape, title: texts.join(' ') };
  }
  return undefined;
}

/** Reader for PresentationML `.pptx` decks: every slide is a `section` (PPT-1, PPT-2, PPT-3). */
export const pptxReader: Reader = {
  id: 'pptx',
  mimeTypes: [PPTX_MIME],
  async read(ctx: ReadContext): Promise<void> {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const xmlContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      ...(ctx.path ? { path: ctx.path } : {}),
    };
    const parts = new OoxmlParts(archive, xmlContext);
    const contentTypes = await readContentTypes(parts, xmlContext);
    const rootRelationships = await readRelationships(parts, '', xmlContext);
    const mainPath =
      relationshipOfType(rootRelationships, 'officeDocument', xmlContext)?.part ?? 'ppt/presentation.xml';
    const mainBytes = await parts.read(mainPath);
    if (!mainBytes) {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The presentation part could not be read.' });
      return;
    }
    const mainType = contentTypes.mimeType(mainPath);
    if (mainType !== undefined && !MAIN_PART_TYPES.has(mainType)) {
      ctx.warnings.add({
        code: 'FORMAT_MISMATCH',
        message: 'The PPTX presentation part has an unexpected content type.',
      });
    }
    const mainContext: XmlContext = {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path: pathWithPrefix(ctx.path, mainPath),
    };
    const relationships = await readRelationships(parts, mainPath, mainContext);
    const order = slideOrder(mainBytes, mainContext);
    // Ancillary XML is staged before slide output charges the shared output allowance.
    ctx.out.setMetadata(await readProperties(parts, mainContext, ctx.options.metadata));
    const features = await scanFeatures(parts, archive, xmlContext);
    if (features.hasMacros) ctx.out.setFeature('hasMacros');
    if (features.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (features.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');
    if (features.isEncrypted) ctx.out.setFeature('isEncrypted');
    if (features.hasJavaScript) ctx.out.setFeature('hasJavaScript');

    // Layouts and masters are parsed once, and only when a slide uses them.
    const templates = new Map<
      string,
      { content: PptxSlideContent; relationships: Map<string, OoxmlRelationship> }
    >();
    const template = async (part: string) => {
      let entry = templates.get(part);
      if (!entry) {
        const bytes = await parts.read(part);
        const path = pathWithPrefix(ctx.path, part);
        entry = {
          content: bytes
            ? parseSlide(bytes, { budget: ctx.budget, warnings: ctx.warnings, path })
            : { shapes: [], depthLimited: false, hidden: false },
          relationships: await readRelationships(parts, part, {
            budget: ctx.budget,
            warnings: ctx.warnings,
            path,
          }),
        };
        templates.set(part, entry);
      }
      return entry;
    };

    let depthWarned = false;
    let hiddenSlides = 0;
    for (let index = 0; index < order.length; index++) {
      ctx.budget.tick();
      const number = index + 1;
      const relationship = relationships.get(order[index]!);
      const part = relationship && !relationship.external ? relationship.part : undefined;
      const bytes = part === undefined ? undefined : await parts.read(part);
      const loc: Location = { slide: number };
      if (part !== undefined) loc.path = pathWithPrefix(ctx.path, part);
      if (!bytes || part === undefined) {
        ctx.warnings.add({ code: 'UNREADABLE_PART', message: `Slide ${number} could not be read.` });
        if (!ctx.out.openSection('slide', loc)) break;
        ctx.out.closeSection();
        continue;
      }
      const slideContext: XmlContext = { budget: ctx.budget, warnings: ctx.warnings, path: loc.path! };
      const slide = parseSlide(bytes, slideContext);
      if (slide.depthLimited && !depthWarned) {
        depthWarned = true;
        ctx.warnings.add({
          code: 'DEPTH_LIMIT',
          message: `Shape groups nested deeper than blockDepth (${ctx.budget.limits.blockDepth}) keep their parent's position.`,
          loc: { path: loc.path! },
        });
      }
      const slideRelationships = await readRelationships(parts, part, slideContext);

      // Placeholders without their own position inherit it from the layout, then the master.
      const sources: PptxSlideContent[] = [];
      if (
        slide.shapes.some((shape) => {
          ctx.budget.tick();
          return shape.placeholder && shape.y === undefined;
        })
      ) {
        const layoutPart = relationshipOfType(slideRelationships, 'slideLayout', slideContext)?.part;
        if (layoutPart !== undefined) {
          const layout = await template(layoutPart);
          sources.push(layout.content);
          const masterPart = relationshipOfType(layout.relationships, 'slideMaster', slideContext)?.part;
          if (masterPart !== undefined) sources.push((await template(masterPart)).content);
        }
      }
      for (const shape of slide.shapes) {
        ctx.budget.tick();
        if (!shape.placeholder || shape.y !== undefined) continue;
        const inherited = inheritedShape(shape.placeholder, sources, slideContext);
        if (inherited) {
          shape.x = inherited.x;
          shape.y = inherited.y;
        }
      }

      const found = slideTitle(slide.shapes, slideContext);
      const titleShape = found?.shape;
      const title = found?.title;
      if (slide.hidden) hiddenSlides++;
      if (!ctx.out.openSection('slide', loc, title, slide.hidden || undefined)) break;
      if (title !== undefined) ctx.out.heading(1, title, loc);

      // Reading order: top to bottom, then left to right; ties and unplaced shapes keep tree order.
      const shapes = slide.shapes
        .filter((shape) => {
          ctx.budget.tick();
          return shape !== titleShape && !(shape.placeholder && SKIPPED_TYPES.has(shape.placeholder.type));
        })
        .sort((a, b) => {
          ctx.budget.tick();
          return (
            (a.y ?? Number.POSITIVE_INFINITY) - (b.y ?? Number.POSITIVE_INFINITY) ||
            (a.x ?? Number.POSITIVE_INFINITY) - (b.x ?? Number.POSITIVE_INFINITY) ||
            a.order - b.order
          );
        });
      let open = true;
      for (const shape of shapes) {
        ctx.budget.tick();
        if (!open) break;
        if (shape.kind === 'table' && shape.rows) {
          if (shape.rows.length > 0)
            open = ctx.out.table(shape.rows, Math.min(shape.headerRows ?? 0, shape.rows.length), loc);
          continue;
        }
        if (shape.kind === 'diagram' && shape.diagramData !== undefined) {
          const dataPart = slideRelationships.get(shape.diagramData);
          const dataBytes =
            dataPart && !dataPart.external && dataPart.part ? await parts.read(dataPart.part) : undefined;
          if (!dataBytes || !dataPart?.part) continue;
          const items = parseDiagramData(dataBytes, {
            budget: ctx.budget,
            warnings: ctx.warnings,
            path: pathWithPrefix(ctx.path, dataPart.part),
          });
          if (items.length > 0) open = ctx.out.list(false, nestItems(items, ctx.budget), loc);
          continue;
        }
        if (shape.placeholder?.type === 'ftr') {
          const lines: string[] = [];
          for (const paragraph of shape.paragraphs) {
            ctx.budget.tick();
            lines.push(paragraph.text);
          }
          const text = lines.join('\n');
          if (text.trim().length > 0) open = ctx.out.headerFooter('footer', text, loc);
          continue;
        }
        open = emitParagraphs(ctx, shape, loc);
      }
      if (open) await emitNotes(ctx, parts, slideRelationships, slideContext, number);
      if (!ctx.out.closeSection()) break;
    }
    if (hiddenSlides > 0) {
      ctx.warnings.add({
        code: 'HIDDEN_CONTENT',
        message: `${hiddenSlides} hidden slides are included with hidden: true.`,
      });
    }
  },
};

/**
 * Speaker notes (PPT-4): the slide's notes part, read like a slide. The notes body placeholder and
 * plain text boxes are kept; the slide image, number, date, header and footer placeholders are not.
 */
async function emitNotes(
  ctx: ReadContext,
  parts: OoxmlParts,
  slideRelationships: ReadonlyMap<string, OoxmlRelationship>,
  slideContext: XmlContext,
  number: number,
): Promise<void> {
  const notesPart = relationshipOfType(slideRelationships, 'notesSlide', slideContext)?.part;
  const bytes = notesPart === undefined ? undefined : await parts.read(notesPart);
  if (!bytes || notesPart === undefined) return;
  const path = pathWithPrefix(ctx.path, notesPart);
  const notes = parseSlide(bytes, { budget: ctx.budget, warnings: ctx.warnings, path });
  const shapes = notes.shapes
    .filter((shape) => {
      ctx.budget.tick();
      return shape.kind === 'text' && (!shape.placeholder || BULLETED_TYPES.has(shape.placeholder.type));
    })
    .sort((a, b) => {
      ctx.budget.tick();
      return (a.y ?? Number.POSITIVE_INFINITY) - (b.y ?? Number.POSITIVE_INFINITY) || a.order - b.order;
    });
  const lines: string[] = [];
  for (const shape of shapes) {
    for (const paragraph of shape.paragraphs) {
      ctx.budget.tick();
      if (paragraph.text.trim().length > 0) lines.push(paragraph.text);
    }
  }
  if (lines.length > 0) ctx.out.note('speaker-notes', lines.join('\n'), { slide: number, path });
}

/** A text shape's paragraphs: bulleted runs become list blocks, the rest paragraph blocks. */
function emitParagraphs(ctx: ReadContext, shape: PptxShape, loc: Location): boolean {
  const bulleted = shape.placeholder !== undefined && BULLETED_TYPES.has(shape.placeholder.type);
  let items: FlatItem[] = [];
  let ordered = false;
  let counters: number[] = [];
  const flush = (): boolean => {
    if (items.length === 0) return true;
    const kept = ctx.out.list(ordered, nestItems(items, ctx.budget), loc);
    items = [];
    counters = [];
    return kept;
  };
  for (const paragraph of shape.paragraphs) {
    ctx.budget.tick();
    if (paragraph.text.trim().length === 0) continue;
    const bullet = paragraph.bullet === 'inherit' ? (bulleted ? 'char' : 'none') : paragraph.bullet;
    if (bullet === 'none') {
      if (!flush() || !ctx.out.paragraph(paragraph.text, loc)) return false;
      continue;
    }
    if (items.length === 0) ordered = bullet === 'auto';
    let marker: string;
    if (bullet === 'auto') {
      const level = paragraph.level;
      const current = counters[level];
      counters[level] = current === undefined ? (paragraph.startAt ?? 1) : current + 1;
      counters.length = level + 1;
      marker = autoNumberMarker(paragraph.autoType ?? 'arabicPeriod', counters[level]);
    } else {
      marker = bulletMarker(paragraph.char, paragraph.symbolFont === true);
    }
    items.push({ text: paragraph.text, level: paragraph.level, marker });
  }
  return flush();
}

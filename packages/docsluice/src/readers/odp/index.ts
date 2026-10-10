import { EncryptedError } from '../../core/errors.js';
import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { parseOdfManifest, parseOdfMetadata } from '../../odf/index.js';
import { openZip } from '../../zip/index.js';
import type { ZipEntry } from '../../zip/index.js';
import { autoNumberMarker, bulletMarker, nestItems } from '../pptx/lists.js';
import type { FlatItem } from '../pptx/lists.js';
import { emptyOdpStyles, parseOdpXml } from './content.js';
import type { OdpListLevel, OdpShape } from './content.js';

const ODP_MIME = 'application/vnd.oasis.opendocument.presentation';
/** Generated placeholder text (date, slide number, header) and the notes-page slide image are not content. */
const SKIPPED_CLASSES: ReadonlySet<string> = new Set([
  'date-time',
  'page-number',
  'header',
  'page',
  'handout',
]);
const NUMBER_BASES = new Map([
  ['1', 'arabic'],
  ['a', 'alphaLc'],
  ['A', 'alphaUc'],
  ['i', 'romanLc'],
  ['I', 'romanUc'],
]);

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

/** The marker of a numbered list level, through the shared PowerPoint numbering schemes. */
function numberMarker(style: OdpListLevel | undefined, value: number): string {
  const base = NUMBER_BASES.get(style?.format ?? '1') ?? 'arabic';
  const prefix = style?.prefix ?? '';
  const suffix = style?.suffix ?? '';
  const scheme =
    prefix === '(' && suffix === ')'
      ? 'ParenBoth'
      : suffix === ')'
        ? 'ParenR'
        : suffix === ''
          ? 'Plain'
          : 'Period';
  return autoNumberMarker(`${base}${scheme}`, value);
}

/** A text shape's paragraphs: list items become list blocks, the rest paragraph blocks. */
function emitParagraphs(ctx: ReadContext, shape: OdpShape, loc: Location): boolean {
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
    if (!paragraph.list) {
      if (!flush() || !ctx.out.paragraph(paragraph.text, loc)) return false;
      continue;
    }
    const { level, style } = paragraph.list;
    const numbered = style?.numbered === true;
    if (items.length === 0) ordered = numbered;
    let marker: string;
    if (numbered) {
      const current = counters[level];
      counters[level] = current === undefined ? (style?.start ?? 1) : current + 1;
      counters.length = level + 1;
      marker = numberMarker(style, counters[level]);
    } else {
      marker = bulletMarker(style?.char, false);
    }
    items.push({ text: paragraph.text, level, marker });
  }
  return flush();
}

/** Reader for OpenDocument presentations: every `draw:page` is a `slide` section, like PPTX (PPT-1..PPT-5). */
export const odpReader: Reader = {
  id: 'odp',
  mimeTypes: [ODP_MIME],
  async read(ctx: ReadContext): Promise<void> {
    const zip = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const entries = new Map<string, ZipEntry | null>();
    let macros = false;
    let embedded = false;
    for (const entry of zip.entries) {
      ctx.budget.tick();
      // A name that appears twice is ambiguous; neither copy is read.
      entries.set(entry.name, entries.has(entry.name) ? null : entry);
      if (entry.name.startsWith('Basic/') || entry.name.startsWith('Scripts/')) macros = true;
      if (entry.name.startsWith('Object ') || entry.name.startsWith('ObjectReplacements/')) embedded = true;
    }
    const readPart = async (name: string): Promise<Uint8Array | undefined> => {
      ctx.budget.tick();
      const entry = entries.get(name);
      if (!entry) {
        if (entry === null || name === 'content.xml')
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message:
              entry === null
                ? 'The ODP package has duplicate part names; that part was not read.'
                : 'The ODP package has no content part.',
            loc: { path: pathWithPrefix(ctx.path, name) },
          });
        return undefined;
      }
      if (entry.isEncrypted) throw new EncryptedError('password-required');
      const data = entry.isUnreadable ? undefined : await zip.read(entry);
      if (!data)
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: 'An ODP package part could not be read.',
          loc: { path: pathWithPrefix(ctx.path, name) },
        });
      return data ?? undefined;
    };

    const manifest = await readPart('META-INF/manifest.xml');
    if (manifest) {
      const parsed = parseOdfManifest(manifest, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path: pathWithPrefix(ctx.path, 'META-INF/manifest.xml'),
      });
      if (parsed.hasEncryptedEntries) {
        ctx.out.setFeature('isEncrypted');
        throw new EncryptedError('password-required');
      }
    }
    const meta = await readPart('meta.xml');
    if (meta) {
      ctx.out.setMetadata(
        parseOdfMetadata(
          meta,
          { budget: ctx.budget, warnings: ctx.warnings, path: pathWithPrefix(ctx.path, 'meta.xml') },
          { metadata: ctx.options.metadata },
        ),
      );
    }
    if (macros) {
      ctx.out.setFeature('hasMacros');
      ctx.warnings.add({
        code: 'MACROS_PRESENT',
        message: 'The document contains macros; they were not executed.',
      });
    }

    // Shared list styles come from styles.xml; content.xml adds its automatic styles and the slides.
    const styles = emptyOdpStyles();
    const stylesBytes = await readPart('styles.xml');
    if (stylesBytes) {
      parseOdpXml(stylesBytes, styles, {
        budget: ctx.budget,
        warnings: ctx.warnings,
        path: pathWithPrefix(ctx.path, 'styles.xml'),
      });
    }
    const path = pathWithPrefix(ctx.path, 'content.xml');
    const bytes = await readPart('content.xml');
    if (!bytes) {
      if (embedded) ctx.out.setFeature('hasEmbeddedFiles');
      return;
    }
    const content = parseOdpXml(bytes, styles, { budget: ctx.budget, warnings: ctx.warnings, path });
    if (content.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    if (embedded || content.hasEmbeddedFiles) ctx.out.setFeature('hasEmbeddedFiles');

    let hiddenSlides = 0;
    for (let index = 0; index < content.slides.length; index++) {
      ctx.budget.tick();
      const slide = content.slides[index]!;
      const number = index + 1;
      const loc: Location = { slide: number, path };
      // The first title placeholder with text: its paragraphs joined by spaces (PPT-2).
      let titleShape: OdpShape | undefined;
      let title: string | undefined;
      for (const shape of slide.shapes) {
        ctx.budget.tick();
        if (shape.className !== 'title') continue;
        const texts = shape.paragraphs.map((item) => item.text.trim()).filter((text) => text.length > 0);
        if (texts.length > 0) {
          titleShape = shape;
          title = texts.join(' ');
          break;
        }
      }
      if (slide.hidden) hiddenSlides++;
      if (!ctx.out.openSection('slide', loc, title, slide.hidden || undefined)) break;
      if (title !== undefined) ctx.out.heading(1, title, loc);
      // Reading order: top to bottom, then left to right; ties and unplaced shapes keep document order.
      const shapes = slide.shapes
        .filter((shape) => {
          ctx.budget.tick();
          return shape !== titleShape && !(shape.className && SKIPPED_CLASSES.has(shape.className));
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
          if (shape.rows.length > 0) open = ctx.out.table(shape.rows, shape.headerRows ?? 0, loc);
          continue;
        }
        if (shape.className === 'footer') {
          const text = shape.paragraphs.map((item) => item.text).join('\n');
          if (text.trim().length > 0) open = ctx.out.headerFooter('footer', text, loc);
          continue;
        }
        open = emitParagraphs(ctx, shape, loc);
      }
      if (open && slide.notes.length > 0) ctx.out.note('speaker-notes', slide.notes.join('\n'), loc);
      if (!ctx.out.closeSection()) break;
      // Each slide is one top-level block; a streaming consumer can apply backpressure here (EXT-2).
      await ctx.out.flush();
    }
    if (hiddenSlides > 0) {
      ctx.warnings.add({
        code: 'HIDDEN_CONTENT',
        message: `${hiddenSlides} hidden slides are included with hidden: true.`,
      });
    }
  },
};

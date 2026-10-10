import { CorruptFileError, DocsluiceError, EncryptedError } from '../../core/errors.js';
import type { Location, Metadata, Run } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openPdf, PdfPasswordError } from './engine.js';
import type { PdfDocument, PdfLink, PdfOutlineItem, PdfTextItem } from './engine.js';
import { pageRanges, parsePdfDate } from './text.js';

/** A page with no text whose images cover at least a quarter of it needs OCR (PDF-4). */
const OCR_COVERAGE = 0.25;
/** A line more than this many line heights below the previous one starts a new paragraph. */
const PARAGRAPH_GAP = 1.6;

interface Line {
  items: PdfTextItem[];
  y: number;
  height: number;
}

/**
 * Lines and paragraphs in content-stream order (reading order arrives with PDF-2): a new line at an
 * engine line end or a vertical jump, a new paragraph after a gap larger than 1.6 line heights.
 */
function paragraphs(items: readonly PdfTextItem[], ctx: ReadContext): PdfTextItem[][] {
  const lines: Line[] = [];
  let line: Line | undefined;
  for (const item of items) {
    ctx.budget.tick();
    const height = Math.max(item.height, 1);
    if (
      line &&
      item.text.trim().length > 0 &&
      Math.abs(item.y - line.y) > Math.max(line.height, height) / 2
    ) {
      lines.push(line);
      line = undefined;
    }
    if (!line) {
      if (item.text.trim().length === 0 && !item.endOfLine) continue;
      line = { items: [], y: item.y, height };
    }
    // Items separated by a visible horizontal gap are separate words.
    const last = line.items.at(-1);
    if (
      last &&
      item.x - (last.x + last.width) > 0.15 * height &&
      !/\s$/u.test(last.text) &&
      !/^\s/u.test(item.text)
    ) {
      line.items.push({ ...item, text: ' ', width: 0, endOfLine: false });
    }
    line.items.push(item);
    line.height = Math.max(line.height, height);
    if (item.endOfLine) {
      lines.push(line);
      line = undefined;
    }
  }
  if (line) lines.push(line);
  const result: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let previous: Line | undefined;
  for (const next of lines) {
    ctx.budget.tick();
    if (previous) {
      const gap = previous.y - next.y;
      if (gap < 0 || gap > PARAGRAPH_GAP * Math.max(previous.height, next.height)) {
        if (current.length > 0) result.push(current);
        current = [];
      } else {
        // A soft line wrap inside a paragraph becomes a space.
        current.push({ ...next.items[0]!, text: ' ', width: 0, endOfLine: false });
      }
    }
    current.push(...next.items);
    previous = next;
  }
  if (current.length > 0) result.push(current);
  return result;
}

function linkFor(item: PdfTextItem, links: readonly PdfLink[]): string | undefined {
  const x = item.x + item.width / 2;
  const y = item.y + item.height / 2;
  for (const link of links) {
    const [x1, y1, x2, y2] = link.rect;
    if (
      link.url &&
      x >= Math.min(x1, x2) &&
      x <= Math.max(x1, x2) &&
      y >= Math.min(y1, y2) &&
      y <= Math.max(y1, y2)
    ) {
      return link.url;
    }
  }
  return undefined;
}

function paragraphText(
  parts: readonly PdfTextItem[],
  links: readonly PdfLink[],
  ctx: ReadContext,
): { text: string; runs?: Run[] } {
  let text = '';
  const runs: Run[] = [];
  let linked = false;
  for (const part of parts) {
    ctx.budget.tick();
    text += part.text;
    if (!ctx.options.runs) continue;
    const href = part.text.trim().length > 0 ? linkFor(part, links) : undefined;
    if (href !== undefined) linked = true;
    const last = runs.at(-1);
    if (last && last.href === href) last.text += part.text;
    else runs.push(href === undefined ? { text: part.text } : { text: part.text, href });
  }
  return linked ? { text, runs } : { text };
}

function metadataOf(info: Awaited<ReturnType<PdfDocument['info']>>, pageCount: number): Partial<Metadata> {
  const metadata: Partial<Metadata> = {};
  const title = info.title ?? info.xmpTitle;
  if (title !== undefined) metadata.title = title.trim();
  const author = info.author ?? info.xmpCreator;
  if (author !== undefined) metadata.authors = [author.trim()];
  const created = info.creationDate === undefined ? undefined : parsePdfDate(info.creationDate);
  if (created !== undefined) metadata.created = created;
  const modified = info.modDate === undefined ? undefined : parsePdfDate(info.modDate);
  if (modified !== undefined) metadata.modified = modified;
  metadata.pageCount = pageCount;
  if (info.language !== undefined) metadata.language = info.language.trim();
  return metadata;
}

async function open(ctx: ReadContext): Promise<PdfDocument> {
  try {
    return await openPdf(ctx.bytes, ctx.options.password);
  } catch (error) {
    if (error instanceof PdfPasswordError) {
      throw new EncryptedError(error.wrongPassword ? 'wrong-password' : 'password-required');
    }
    if (error instanceof DocsluiceError) throw error;
    throw new CorruptFileError('The PDF could not be opened.', { cause: error });
  }
}

/**
 * Reader for PDF (PDF-1, PDF-4, PDF-6, PDF-10): one `section` per page with its page number and
 * label, outline entries as headings on their target page, link targets, metadata, and `needsOcr`
 * for pages without a text layer. The engine never runs PDF JavaScript, never fetches, and never
 * follows launch or remote actions; their presence is reported.
 */
export const pdfReader: Reader = {
  id: 'pdf',
  mimeTypes: ['application/pdf'],
  async read(ctx: ReadContext): Promise<void> {
    const pdf = await open(ctx);
    try {
      ctx.budget.tick();
      ctx.out.setMetadata(metadataOf(await pdf.info(), pdf.pageCount));
      if (await pdf.hasJavaScript()) ctx.out.setFeature('hasJavaScript');
      if (await pdf.hasAttachments()) ctx.out.setFeature('hasEmbeddedFiles');
      const labels = await pdf.pageLabels();

      // Outline entries are headings at the start of their target page; unresolved ones open the first page.
      const outline = new Map<number, PdfOutlineItem[]>();
      for (const item of await pdf.outline(ctx.budget)) {
        ctx.budget.tick();
        const index = item.pageIndex !== undefined && item.pageIndex < pdf.pageCount ? item.pageIndex : 0;
        const list = outline.get(index) ?? [];
        list.push(item);
        outline.set(index, list);
      }

      const needsOcr: number[] = [];
      for (let index = 0; index < pdf.pageCount; index++) {
        ctx.budget.tick();
        if (!ctx.budget.addPages(1)) break;
        const number = index + 1;
        const loc: Location = { page: number };
        const label = labels === undefined ? undefined : labels[index];
        if (label !== undefined && label !== String(number)) loc.pageLabel = label;

        let content;
        try {
          content = await pdf.page(index, ctx.budget);
        } catch (error) {
          if (error instanceof DocsluiceError) throw error;
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message: `Page ${number} could not be read.`,
            loc: { page: number },
          });
          if (!ctx.out.openSection('page', loc)) break;
          ctx.out.closeSection();
          continue;
        }
        if (content.hasJavaScript) ctx.out.setFeature('hasJavaScript');
        if (content.links.length > 0) ctx.out.setFeature('hasExternalLinks');
        const hasText = content.items.some((item) => item.text.trim().length > 0);
        let pageNeedsOcr = false;
        if (!hasText && (await pdf.imageCoverage(index, ctx.budget).catch(() => 0)) >= OCR_COVERAGE) {
          pageNeedsOcr = true;
          needsOcr.push(number);
        }

        if (!ctx.out.openSection('page', loc, undefined, undefined, pageNeedsOcr)) break;
        let open = true;
        for (const item of outline.get(index) ?? []) {
          ctx.budget.tick();
          open = ctx.out.heading(Math.min(item.depth + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6, item.title, loc);
          if (!open) break;
        }
        for (const parts of open ? paragraphs(content.items, ctx) : []) {
          ctx.budget.tick();
          const { text, runs } = paragraphText(parts, content.links, ctx);
          if (text.trim().length === 0) continue;
          if (!ctx.out.paragraph(text, loc, runs)) break;
        }
        if (!ctx.out.closeSection()) break;
      }
      if (needsOcr.length > 0) {
        ctx.out.setNeedsOcr();
        ctx.warnings.add({
          code: 'NEEDS_OCR',
          message: `Pages without a text layer need OCR: ${pageRanges(needsOcr)}.`,
        });
      }
    } finally {
      await pdf.close();
    }
  },
};

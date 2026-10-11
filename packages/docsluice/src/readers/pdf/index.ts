import { CorruptFileError, DocsluiceError, EncryptedError } from '../../core/errors.js';
import type { Location, Metadata, Run } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openPdf, PdfPasswordError } from './engine.js';
import type { PdfDocument, PdfLink, PdfOutlineItem, PdfTextItem } from './engine.js';
import { layoutPage } from './layout/index.js';
import type { LayoutParagraph } from './layout/index.js';
import { pageRanges, parsePdfDate } from './text.js';

/** A page with no text whose images cover at least a quarter of it needs OCR (PDF-4). */
const OCR_COVERAGE = 0.25;
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
  parts: LayoutParagraph<PdfTextItem>['parts'],
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
    const href = part.item && part.text.trim().length > 0 ? linkFor(part.item, links) : undefined;
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

/**
 * Charge fonts the engine loaded since the last call. When the engine refused a font, charge one
 * more to cross the `pdfFonts` limit: that throws or truncates as `onLimit` says.
 */
function chargeFonts(pdf: PdfDocument, ctx: ReadContext, charged: { fonts: number }): boolean {
  const fresh = pdf.fontsLoaded - charged.fonts;
  charged.fonts = pdf.fontsLoaded;
  const within = ctx.budget.addFonts(fresh);
  return within && (!pdf.fontsDenied || ctx.budget.addFonts(1));
}

async function open(ctx: ReadContext): Promise<PdfDocument> {
  try {
    // Fonts are shared across every PDF in one extraction (NST-1): give the engine what is left.
    const fontLimit = Math.max(0, ctx.budget.limits.pdfFonts - ctx.budget.fonts);
    return await openPdf(ctx.bytes, ctx.options.password, fontLimit);
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
      const charged = { fonts: 0 };
      // Past the font limit, keep the page in progress, then stop.
      let fontsLeft = true;
      for (let index = 0; fontsLeft && index < pdf.pageCount; index++) {
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
          fontsLeft = chargeFonts(pdf, ctx, charged);
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message: `Page ${number} could not be read.`,
            loc: { page: number },
          });
          if (!ctx.out.openSection('page', loc)) break;
          ctx.out.closeSection();
          continue;
        }
        fontsLeft = chargeFonts(pdf, ctx, charged);
        if (content.hasJavaScript) ctx.out.setFeature('hasJavaScript');
        if (content.links.length > 0) ctx.out.setFeature('hasExternalLinks');
        const hasText = content.items.some((item) => item.text.trim().length > 0);
        let pageNeedsOcr = false;
        if (!hasText && fontsLeft) {
          const coverage = await pdf.imageCoverage(index, ctx.budget).catch((error: unknown) => {
            if (error instanceof DocsluiceError) throw error;
            return 0;
          });
          fontsLeft = chargeFonts(pdf, ctx, charged);
          if (coverage >= OCR_COVERAGE) {
            pageNeedsOcr = true;
            needsOcr.push(number);
          }
        }

        if (!ctx.out.openSection('page', loc, undefined, undefined, pageNeedsOcr)) break;
        let open = true;
        for (const item of outline.get(index) ?? []) {
          ctx.budget.tick();
          open = ctx.out.heading(Math.min(item.depth + 1, 6) as 1 | 2 | 3 | 4 | 5 | 6, item.title, loc);
          if (!open) break;
        }
        // Font-size headings only when the document has no outline to give them (PDF-2).
        const layout = open ? layoutPage(content.items, { headings: outline.size === 0 }, ctx.budget) : [];
        for (const { parts, heading } of layout) {
          ctx.budget.tick();
          const { text, runs } = paragraphText(parts, content.links, ctx);
          if (text.trim().length === 0) continue;
          const written =
            heading === undefined
              ? ctx.out.paragraph(text, loc, runs)
              : ctx.out.heading(heading, text.trim(), loc);
          if (!written) break;
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

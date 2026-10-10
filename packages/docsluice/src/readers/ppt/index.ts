import { CorruptFileError } from '../../core/errors.js';
import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openCfb } from '../../ole/index.js';
import type { CfbArchive } from '../../ole/index.js';
import { parsePresentation, TEXT_CENTER_TITLE, TEXT_TITLE } from './records.js';
import type { PptText } from './records.js';

function readStream(ctx: ReadContext, archive: CfbArchive, name: string): Uint8Array {
  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (entry.type === 'stream' && entry.path === name) return archive.read(entry.path);
  }
  throw new CorruptFileError('A required PowerPoint stream is missing.');
}

const isTitle = (text: PptText): boolean => text.type === TEXT_TITLE || text.type === TEXT_CENTER_TITLE;

/**
 * Reader for PowerPoint 97-2003 `.ppt` decks ([MS-PPT]): every slide is a `section` with its title,
 * text and speaker notes, in slide order, like the PPTX reader.
 */
export const pptReader: Reader = {
  id: 'ppt',
  mimeTypes: ['application/vnd.ms-powerpoint'],
  async read(ctx): Promise<void> {
    await Promise.resolve();
    const archive = ctx.cfb ?? openCfb(ctx.bytes, ctx.budget);
    const currentUser = readStream(ctx, archive, 'Current User');
    const document = readStream(ctx, archive, 'PowerPoint Document');
    const presentation = parsePresentation(document, currentUser, ctx.budget, ctx.warnings);
    if (presentation.depthLimited) {
      ctx.warnings.add({
        code: 'DEPTH_LIMIT',
        message: `Drawing containers nested deeper than blockDepth (${ctx.budget.limits.blockDepth}) were not read.`,
      });
    }
    for (let index = 0; index < presentation.slides.length; index++) {
      ctx.budget.tick();
      const slide = presentation.slides[index]!;
      const loc: Location = { slide: index + 1 };
      if (ctx.path) loc.path = ctx.path;
      const titleText = slide.texts.find(isTitle);
      const title = titleText?.paragraphs
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0)
        .join(' ');
      if (!ctx.out.openSection('slide', loc, title || undefined)) return;
      if (title && !ctx.out.heading(1, title, loc)) return;
      for (const text of slide.texts) {
        ctx.budget.tick();
        if (text === titleText) continue;
        for (const paragraph of text.paragraphs) {
          ctx.budget.tick();
          if (paragraph.trim().length > 0 && !ctx.out.paragraph(paragraph, loc)) return;
        }
      }
      const notes = slide.notes.filter((note) => note.trim().length > 0).join('\n');
      if (notes.length > 0 && !ctx.out.note('speaker-notes', notes, loc)) return;
      if (!ctx.out.closeSection()) return;
    }
  },
};

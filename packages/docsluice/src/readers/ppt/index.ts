import type { Reader } from '../../core/reader.js';
import type { ReadContext } from '../../core/reader.js';
import { CorruptFileError } from '../../core/errors.js';
import { openCfb } from '../../ole/index.js';
import type { CfbArchive } from '../../ole/index.js';
import { parsePresentation } from './records.js';

function streamPath(cfb: CfbArchive, name: string, ctx: ReadContext): string | undefined {
  let fallback: string | undefined;
  for (const entry of cfb.entries) {
    ctx.budget.tick();
    if (entry.type !== 'stream') continue;
    if (entry.path === name) return entry.path;
    if (entry.path.toLowerCase() === name.toLowerCase()) fallback ??= entry.path;
  }
  return fallback;
}

/** PowerPoint 97-2003 reader. */
export const pptReader: Reader = {
  id: 'ppt',
  mimeTypes: ['application/vnd.ms-powerpoint'],
  read(ctx) {
    return Promise.resolve().then(() => {
      ctx.budget.tick();
      const cfb = ctx.cfb ?? openCfb(ctx.bytes, ctx.budget);
      const userPath = streamPath(cfb, 'Current User', ctx);
      const documentPath = streamPath(cfb, 'PowerPoint Document', ctx);
      if (ctx.budget.truncated) return;
      if (userPath === undefined || documentPath === undefined) {
        throw new CorruptFileError('The presentation streams are missing.');
      }
      const currentUser = cfb.read(userPath);
      if (ctx.budget.truncated) return;
      const documentStream = cfb.read(documentPath);
      if (ctx.budget.truncated) return;
      const slides = parsePresentation(documentStream, currentUser, ctx.budget);
      for (let index = 0; index < slides.length; index++) {
        ctx.budget.tick();
        const slide = slides[index]!;
        const loc = ctx.path === '' ? { slide: index + 1 } : { slide: index + 1, path: ctx.path };
        let title: string | undefined;
        for (const text of slide.texts) {
          ctx.budget.tick();
          if (text.type === 0 || text.type === 6) {
            title = text.text;
            break;
          }
        }
        const opened = ctx.out.openSection('slide', loc, title);
        // Even a failed title allowance opens a logical section in DocBuilder.
        try {
          if (!opened) return;
          for (const text of slide.texts) {
            ctx.budget.tick();
            if (text.text.length === 0) continue;
            const kept =
              text.type === 0 || text.type === 6
                ? ctx.out.heading(1, text.text, loc)
                : ctx.out.paragraph(text.text, loc);
            if (!kept) return;
          }
          for (const note of slide.notes) {
            ctx.budget.tick();
            if (note.length > 0 && !ctx.out.note('speaker-notes', note, loc)) return;
          }
        } finally {
          ctx.out.closeSection();
        }
      }
    });
  },
};

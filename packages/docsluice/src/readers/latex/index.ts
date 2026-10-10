import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { decodeTextInput } from '../text-input.js';
import { parseLatex } from './parse.js';

/**
 * Reader for LaTeX sources (`.tex`, ADR 0016): headings from sectioning commands, lists, `tabular`
 * tables, verbatim and display math as code, and paragraphs with the commands stripped. Macros are
 * never expanded and nothing is run (SEC-11).
 */
export const latexReader: Reader = {
  id: 'latex',
  mimeTypes: ['application/x-latex'],
  async read(ctx: ReadContext): Promise<void> {
    await Promise.resolve();
    const text = decodeTextInput(ctx);
    if (text === undefined) return;
    const document = parseLatex(text, ctx.budget);
    if (document.title !== undefined) ctx.out.setMetadata({ title: document.title });
    if (document.authors.length > 0 && ctx.options.metadata)
      ctx.out.setMetadata({ authors: document.authors });
    if (document.depthLimited) {
      ctx.warnings.add({
        code: 'DEPTH_LIMIT',
        message: `Groups or lists nested deeper than blockDepth (${ctx.budget.limits.blockDepth}) were flattened.`,
      });
    }
    const loc: Location = ctx.path ? { path: ctx.path } : {};
    for (const block of document.blocks) {
      ctx.budget.tick();
      let kept: boolean;
      if (block.kind === 'heading')
        kept = ctx.out.heading(block.level as 1 | 2 | 3 | 4 | 5 | 6, block.text, loc);
      else if (block.kind === 'paragraph') kept = ctx.out.paragraph(block.text, loc);
      else if (block.kind === 'list') kept = ctx.out.list(block.ordered, block.items, loc);
      else if (block.kind === 'code') kept = ctx.out.code(block.text, loc, block.language);
      else kept = ctx.out.table(block.rows, Math.min(block.headerRows, block.rows.length), loc);
      if (!kept) return;
    }
  },
};

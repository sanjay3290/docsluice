import { CorruptFileError } from '../../core/errors.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openCfb } from '../../ole/index.js';
import type { CfbArchive } from '../../ole/index.js';
import { docTableStreamName, parseDocStreams } from './parser.js';

const MIME_TYPES = ['application/msword'] as const;

function readStream(ctx: ReadContext, archive: CfbArchive, path: string): Uint8Array {
  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (entry.type === 'stream' && entry.path === path) return archive.read(path);
  }
  throw new CorruptFileError('A required Word document stream is missing.');
}

/** Reader adapter for the bounded text-only MS-DOC parser. */
export const docReader: Reader = {
  id: 'doc',
  mimeTypes: MIME_TYPES,
  async read(ctx): Promise<void> {
    await Promise.resolve();
    const archive = ctx.cfb ?? openCfb(ctx.bytes, ctx.budget);
    const wordDocument = readStream(ctx, archive, 'WordDocument');
    const tableName = docTableStreamName(wordDocument);
    const tableBytes = readStream(ctx, archive, tableName);
    const blocks = parseDocStreams(
      wordDocument,
      tableName === '0Table'
        ? { zeroTable: tableBytes, oneTable: new Uint8Array(0) }
        : { zeroTable: new Uint8Array(0), oneTable: tableBytes },
      ctx.budget,
    );
    const loc = ctx.path ? { path: ctx.path } : {};
    for (const block of blocks) {
      ctx.budget.tick();
      if (!ctx.budget.canRead) break;
      let emitted: boolean;
      if (block.kind === 'paragraph') emitted = ctx.out.paragraph(block.text, loc);
      else if (block.kind === 'heading') emitted = ctx.out.heading(block.level, block.text, loc);
      else {
        const rows: Array<Array<{ text: string }>> = [];
        for (const row of block.rows) {
          ctx.budget.tick();
          const cells: Array<{ text: string }> = [];
          for (const cell of row) {
            ctx.budget.tick();
            cells.push({ text: cell.text });
          }
          rows.push(cells);
        }
        emitted = ctx.out.table(rows, 0, loc);
      }
      if (!emitted) break;
    }
  },
};

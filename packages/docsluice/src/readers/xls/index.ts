import { CorruptFileError } from '../../core/errors.js';
import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openCfb } from '../../ole/index.js';
import type { CfbArchive } from '../../ole/index.js';
import { emitSheetTables } from '../xlsx/emit.js';
import { parseGlobals, parseSheet } from './workbook.js';

const XLS_MIME = 'application/vnd.ms-excel';
const STREAM = 'Workbook';
/** The BIFF5 stream name; those workbooks are not supported. */
const BIFF5_STREAM = 'Book';

function hasStream(archive: CfbArchive, path: string, ctx: ReadContext): boolean {
  for (const entry of archive.entries) {
    ctx.budget.tick();
    if (entry.type === 'stream' && entry.path === path) return true;
  }
  return false;
}

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

/** Reader for BIFF8 `.xls` workbooks (Excel 97 to 2003): the same sheet sections and tables as XLSX. */
export const xlsReader: Reader = {
  id: 'xls',
  mimeTypes: [XLS_MIME],
  async read(ctx: ReadContext): Promise<void> {
    await Promise.resolve();
    const archive = ctx.cfb ?? openCfb(ctx.bytes, ctx.budget);
    // Macros and embedded objects live in storages next to the Workbook stream.
    for (const entry of archive.entries) {
      ctx.budget.tick();
      const top = entry.path.split('/', 1)[0] ?? '';
      if (top === '_VBA_PROJECT_CUR') ctx.out.setFeature('hasMacros');
      else if (top.startsWith('MBD') && entry.type === 'storage') ctx.out.setFeature('hasEmbeddedFiles');
    }
    if (!hasStream(archive, STREAM, ctx)) {
      if (hasStream(archive, BIFF5_STREAM, ctx)) {
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: 'BIFF5 and older Excel workbooks (Excel 95 and earlier) are not supported.',
        });
        return;
      }
      throw new CorruptFileError('The Workbook stream is missing.');
    }
    const stream = archive.read(STREAM);
    const path = pathWithPrefix(ctx.path, STREAM);
    const xlsContext = { budget: ctx.budget, warnings: ctx.warnings };
    const workbook = parseGlobals(stream, xlsContext);
    if (!workbook) {
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'The workbook is not BIFF8; Excel 95 and older workbooks are not supported.',
        loc: { path },
      });
      return;
    }
    let damaged = workbook.damaged;
    let badSharedString = false;
    const parsedOffsets = new Set<number>();
    for (let index = 0; index < workbook.sheets.length; index++) {
      ctx.budget.tick();
      const entry = workbook.sheets[index]!;
      const loc: Location = { path };
      if (entry.name.length > 0) loc.sheet = entry.name;
      if (!ctx.out.openSection('sheet', loc, loc.sheet, entry.hidden)) break;
      // Chart sheets, macro sheets and modules hold no cells; their section stays empty, as in XLSX.
      // A sheet offset seen before is not parsed twice, so offsets cannot multiply the work.
      if (entry.kind !== 0 || parsedOffsets.has(entry.offset)) {
        if (entry.kind === 1 || entry.kind === 6) ctx.out.setFeature('hasMacros');
        if (entry.kind === 0) damaged = true;
        if (!ctx.out.closeSection()) break;
        continue;
      }
      parsedOffsets.add(entry.offset);
      const result = parseSheet(stream, entry, workbook, xlsContext);
      if (result.damaged) damaged = true;
      if (result.badSharedString) badSharedString = true;
      emitSheetTables(ctx, result.sheet, index, loc.sheet, path);
      if (!ctx.out.closeSection()) break;
      // Each sheet is one top-level block; a streaming consumer can apply backpressure here (EXT-2).
      await ctx.out.flush();
    }
    if (badSharedString)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'A shared-string index is out of range; the cell is empty.',
        loc: { path },
      });
    if (damaged || workbook.stringsDamaged)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'Some workbook records are damaged; the data read before them is kept.',
        loc: { path },
      });
  },
};

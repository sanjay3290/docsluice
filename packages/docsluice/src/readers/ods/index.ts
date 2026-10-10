import { EncryptedError } from '../../core/errors.js';
import type { Location } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { parseOdfManifest, parseOdfMetadata } from '../../odf/index.js';
import { openZip } from '../../zip/index.js';
import type { ZipEntry } from '../../zip/index.js';
import { emitSheetTables } from '../xlsx/emit.js';
import { parseOdsContent } from './content.js';

const ODS_MIME = 'application/vnd.oasis.opendocument.spreadsheet';

function pathWithPrefix(prefix: string, part: string): string {
  return prefix ? `${prefix}/${part}` : part;
}

/** Reader for OpenDocument spreadsheets: the same sheet sections and tables as XLSX (XLS-1..XLS-7). */
export const odsReader: Reader = {
  id: 'ods',
  mimeTypes: [ODS_MIME],
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
        if (entry === null)
          ctx.warnings.add({
            code: 'UNREADABLE_PART',
            message: 'The ODS package has duplicate part names; that part was not read.',
            loc: { path: pathWithPrefix(ctx.path, name) },
          });
        return undefined;
      }
      if (entry.isEncrypted) throw new EncryptedError('password-required');
      const data = entry.isUnreadable ? undefined : await zip.read(entry);
      if (!data)
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: 'An ODS package part could not be read.',
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
    if (embedded) ctx.out.setFeature('hasEmbeddedFiles');

    const path = pathWithPrefix(ctx.path, 'content.xml');
    const bytes = await readPart('content.xml');
    if (!bytes) {
      if (!entries.has('content.xml'))
        ctx.warnings.add({
          code: 'UNREADABLE_PART',
          message: 'The ODS package has no content part.',
          loc: { path },
        });
      return;
    }
    const content = parseOdsContent(bytes, {
      budget: ctx.budget,
      warnings: ctx.warnings,
      path,
      formulas: ctx.options.formulas,
    });
    if (content.hasExternalLinks) ctx.out.setFeature('hasExternalLinks');
    for (let index = 0; index < content.sheets.length; index++) {
      ctx.budget.tick();
      const { name, hidden, sheet } = content.sheets[index]!;
      const loc: Location = {};
      if (name !== undefined && name.length > 0) loc.sheet = name;
      loc.path = path;
      if (!ctx.out.openSection('sheet', loc, loc.sheet, hidden)) break;
      emitSheetTables(ctx, sheet, index, loc.sheet, path);
      if (!ctx.out.closeSection()) break;
      // Each sheet is one top-level block; a streaming consumer can apply backpressure here (EXT-2).
      await ctx.out.flush();
    }
  },
};

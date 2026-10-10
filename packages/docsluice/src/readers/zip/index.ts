import type { ChildDocument } from '../../core/model.js';
import type { Reader, ReadContext } from '../../core/reader.js';
import { openZip } from '../../zip/index.js';
import type { ZipEntry } from '../../zip/index.js';

/** Operating-system files that are never content: macOS resource forks and folder caches. */
function isJunk(name: string): boolean {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  return (
    lower.startsWith('__macosx/') ||
    lower.includes('/__macosx/') ||
    base === '.ds_store' ||
    base === 'thumbs.db' ||
    base === 'desktop.ini'
  );
}

function childPath(ctx: ReadContext, name: string): string {
  return ctx.path ? `${ctx.path}/${name}` : name;
}

function listed(ctx: ReadContext, entry: ZipEntry, status: ChildDocument['status']): ChildDocument {
  return { path: childPath(ctx, entry.name), name: entry.name, status, sizeBytes: entry.uncompressedSize };
}

/**
 * Reader for plain ZIP archives (NST-1 … NST-6): no blocks of its own and one child per entry, in
 * central-directory order. Directories and operating-system files are listed as `skipped`;
 * encrypted entries `failed` with `ENCRYPTED`. With `children: 'list'` no entry data is read; with
 * `'extract'` each entry is inflated under the shared budget and read as a child document, one at a
 * time, so at most one entry's bytes are held by this reader.
 */
export const zipReader: Reader = {
  id: 'zip',
  mimeTypes: ['application/zip'],
  async read(ctx: ReadContext): Promise<void> {
    if (ctx.options.children === 'skip') return;
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    for (const entry of archive.entries) {
      ctx.budget.tick();
      if (entry.name.length === 0 || entry.name.endsWith('/') || isJunk(entry.name)) {
        ctx.out.addChild(listed(ctx, entry, 'skipped'));
        continue;
      }
      if (entry.isEncrypted) {
        ctx.out.setFeature('isEncrypted');
        ctx.out.addChild({
          ...listed(ctx, entry, 'failed'),
          error: { code: 'ENCRYPTED', message: 'The entry is encrypted.' },
        });
        continue;
      }
      if (ctx.options.children === 'list') {
        ctx.out.addChild(listed(ctx, entry, 'listed'));
        continue;
      }
      const bytes = entry.isUnreadable ? null : await archive.read(entry);
      if (bytes === null) {
        const limited = ctx.budget.totalUncompressedBytes >= ctx.budget.limits.totalUncompressedBytes;
        ctx.out.addChild({
          ...listed(ctx, entry, 'failed'),
          error: limited
            ? {
                code: 'LIMIT_EXCEEDED',
                message: 'The entry was not read: the uncompressed-byte limit was reached.',
              }
            : { code: 'CORRUPT_FILE', message: 'The entry could not be read.' },
        });
        continue;
      }
      await ctx.extractChild(entry.name, bytes);
    }
  },
};

import type { ChildDocument, FormatId } from '../../core/model.js';
import { EncryptedError } from '../../core/errors.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { openZip, type ZipEntry } from '../../zip/index.js';

const ZIP_MIME_TYPES = ['application/zip', 'application/x-zip-compressed'] as const;
const UNREADABLE_MESSAGE = 'The archive entry could not be read.';
const RECURSIVE_MESSAGE = 'A recursive archive entry was not opened.';

/** Read a plain ZIP as ordered child documents without writing archive paths to disk. */
export const zipReader: Reader = {
  id: 'zip' satisfies FormatId,
  mimeTypes: ZIP_MIME_TYPES,
  async read(ctx: ReadContext): Promise<void> {
    const archive = ctx.zip ?? openZip(ctx.bytes, ctx.budget);
    const mode = ctx.options.children;
    let childDepthChecked = false;
    let childDepthBlocked = false;

    for (const entry of archive.entries) {
      if (mode === 'extract' && ctx.budget.truncated && !childDepthBlocked) break;
      ctx.budget.tick();

      if (isDirectory(entry.name) || isOperatingSystemJunk(entry.name, ctx.budget)) {
        addChild(ctx, entry, 'skipped');
        continue;
      }

      ctx.out.setFeature('hasEmbeddedFiles');

      if (entry.isEncrypted) {
        ctx.out.setFeature('isEncrypted');
        addChild(ctx, entry, 'failed', new EncryptedError('unsupported-encryption'));
        continue;
      }

      if (entry.isUnreadable) {
        addChild(ctx, entry, 'failed', { code: 'UNREADABLE_PART', message: UNREADABLE_MESSAGE });
        continue;
      }

      if (mode === 'skip') continue;

      if (mode === 'list') {
        addChild(ctx, entry, 'listed');
        continue;
      }

      if (!childDepthChecked) {
        childDepthChecked = true;
        childDepthBlocked = !ctx.budget.child().canRead;
      }
      if (childDepthBlocked) {
        addChild(ctx, entry, 'listed');
        continue;
      }

      const bytes = await archive.read(entry);
      if (bytes === null) {
        addChild(ctx, entry, 'failed', { code: 'UNREADABLE_PART', message: UNREADABLE_MESSAGE });
        continue;
      }

      if (sameBytes(bytes, ctx.bytes, ctx)) {
        addChild(ctx, entry, 'failed', { code: 'CORRUPT_FILE', message: RECURSIVE_MESSAGE });
        continue;
      }

      await ctx.extractChild(entry.name, bytes);
    }
  },
};

function addChild(
  ctx: ReadContext,
  entry: ZipEntry,
  status: ChildDocument['status'],
  error?: ChildDocument['error'],
): void {
  const path = ctx.path === '' ? entry.name : `${ctx.path}/${entry.name}`;
  const child: ChildDocument = {
    path,
    name: entry.name,
    status,
    sizeBytes: entry.uncompressedSize,
  };
  if (error !== undefined) child.error = error;
  ctx.out.addChild(child);
}

function isDirectory(name: string): boolean {
  return name.endsWith('/');
}

function isOperatingSystemJunk(name: string, ctxBudget: ReadContext['budget']): boolean {
  const segments = name.split('/');
  for (const segment of segments) {
    ctxBudget.tick();
    if (segment === '__MACOSX' || segment === '.DS_Store' || segment.toLowerCase() === 'thumbs.db') {
      return true;
    }
  }
  return false;
}

function sameBytes(left: Uint8Array, right: Uint8Array, ctx: ReadContext): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    ctx.budget.tick();
    if (left[index] !== right[index]) return false;
  }
  return true;
}

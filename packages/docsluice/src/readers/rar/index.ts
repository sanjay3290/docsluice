import type { FormatPlugin } from '../../core/registry.js';
import { addListedEntries } from '../archive-list/index.js';
import { hasSignature, listRar, RAR4_SIGNATURE, RAR5_SIGNATURE } from './archive.js';

/**
 * RAR 4 and RAR 5 archives as an opt-in format plugin (ADR 0014): `registerFormat(rarPlugin)` or a
 * registry from `createRegistry()`. Entries are listed with names and sizes from the headers; no
 * RAR data is decompressed.
 */
export const rarPlugin: FormatPlugin = {
  id: 'rar',
  contract: '1.0.0',
  mimeTypes: ['application/vnd.rar'],
  extensions: ['rar'],
  detect(bytes) {
    return hasSignature(bytes, RAR5_SIGNATURE) || hasSignature(bytes, RAR4_SIGNATURE) ? 1 : 0;
  },
  async read(ctx) {
    await Promise.resolve();
    const listing = listRar(ctx.bytes, ctx.budget);
    if (listing.encrypted) ctx.out.setFeature('isEncrypted');
    if (listing.damaged) {
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: `The RAR headers are damaged after ${listing.entries.length} entries; the entries before the damage are listed.`,
      });
    }
    addListedEntries(ctx, listing.entries);
  },
};

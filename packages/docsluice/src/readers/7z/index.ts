import type { FormatPlugin } from '../../core/registry.js';
import { addListedEntries } from '../archive-list/index.js';
import { list7z, SIGNATURE } from './archive.js';

/**
 * 7z archives as an opt-in format plugin (ADR 0014): `registerFormat(sevenZipPlugin)` or a
 * registry from `createRegistry()`. Entries are listed with names and sizes; contents are not
 * decompressed.
 */
export const sevenZipPlugin: FormatPlugin = {
  id: '7z',
  contract: '1.0.0',
  mimeTypes: ['application/x-7z-compressed'],
  extensions: ['7z'],
  detect(bytes) {
    for (let index = 0; index < SIGNATURE.length; index++) if (bytes[index] !== SIGNATURE[index]) return 0;
    return 1;
  },
  async read(ctx) {
    await Promise.resolve();
    const listing = list7z(ctx.bytes, ctx.budget);
    if (listing.encrypted) ctx.out.setFeature('isEncrypted');
    addListedEntries(ctx, listing.entries);
  },
};

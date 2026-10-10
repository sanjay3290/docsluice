import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../src/core/extract.js';
import type { Block } from '../../src/core/model.js';

const corpus = new URL('../../../../corpus/', import.meta.url);

/** Blocks without locations or package-specific image paths, so the two formats can be compared. */
function comparable(blocks: Block[]): unknown[] {
  return blocks.map((block) => {
    const copy: Partial<Block> = { ...block };
    delete copy.loc;
    return copy.kind === 'image' ? { ...copy, ref: '<image>' } : copy;
  });
}

describe('ODT and DOCX parity', () => {
  it.each(['headings-outline', 'lists-tables', 'hyperlinks-image', 'notes-comments-revisions'])(
    '%s gives the same blocks from the LibreOffice DOCX and ODT exports',
    async (name) => {
      const read = (format: string) =>
        extract(new Uint8Array(readFileSync(new URL(`${format}/${name}.${format}`, corpus))), {
          filename: `${name}.${format}`,
        });
      const [docx, odt] = await Promise.all([read('docx'), read('odt')]);
      expect(odt.format).toBe('odt');
      expect(comparable(odt.blocks)).toEqual(comparable(docx.blocks));
    },
  );
});

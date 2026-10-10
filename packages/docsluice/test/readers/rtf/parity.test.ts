import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../../src/core/extract.js';
import type { Block } from '../../../src/core/model.js';

const corpus = new URL('../../../../../corpus/', import.meta.url);

/** Blocks without locations or package-specific image paths, so the two formats can be compared. */
function comparable(blocks: Block[]): unknown[] {
  return blocks.map((block) => {
    const copy: Partial<Block> = { ...block };
    delete copy.loc;
    return copy.kind === 'image' ? { ...copy, ref: '<image>' } : copy;
  });
}

const read = (name: string, format: string) =>
  extract(new Uint8Array(readFileSync(new URL(`${format}/${name}.${format}`, corpus))), {
    filename: `${name}.${format}`,
  });

/**
 * What LibreOffice's RTF export itself loses, checked in the RTF source: the custom outline level of
 * one heading is not written, and the outer `\cell` after a nested table is missing, so "Bed N2" stays
 * in the first cell. The expected DOCX blocks are adjusted for exactly these losses and nothing else.
 */
const EXPORT_LOSSES = new Map<string, (blocks: unknown[]) => void>([
  [
    'headings-outline',
    (blocks) => {
      const index = blocks.findIndex(
        (block) => (block as { text?: string }).text === 'Custom Outline Level Three',
      );
      blocks[index] = { kind: 'paragraph', text: 'Custom Outline Level Three' };
    },
  ],
  [
    'lists-tables',
    (blocks) => {
      const table = blocks.find((block) => (block as { kind: string }).kind === 'table') as {
        rows: Array<Array<{ text: string; rowSpan?: number }>>;
      };
      table.rows[1] = [
        { text: 'Bed N1 plus N3 (vertical merge)\nInner plot (nested table)\nBed N2', rowSpan: 2 },
        { text: 'High marsh' },
      ];
    },
  ],
]);

describe('RTF and DOCX parity', () => {
  it.each(['headings-outline', 'lists-tables', 'hyperlinks-image', 'notes-comments-revisions'])(
    '%s gives the same blocks from the LibreOffice DOCX and RTF exports',
    async (name) => {
      const [docx, rtf] = await Promise.all([read(name, 'docx'), read(name, 'rtf')]);
      expect(rtf.format).toBe('rtf');
      const expected = comparable(docx.blocks);
      EXPORT_LOSSES.get(name)?.(expected);
      expect(comparable(rtf.blocks)).toEqual(expected);
      expect(rtf.warnings.map(({ code }) => code)).toEqual(docx.warnings.map(({ code }) => code));
    },
  );
});

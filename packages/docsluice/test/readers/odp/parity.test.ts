import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../../src/core/extract.js';
import type { Block } from '../../../src/core/model.js';

const corpus = new URL('../../../../../corpus/', import.meta.url);

/** Blocks without locations, which name different parts in the two packages. */
function comparable(blocks: Block[]): unknown {
  return JSON.parse(
    JSON.stringify(blocks, (key: string, value: unknown) => (key === 'loc' ? undefined : value)),
  );
}

const read = (name: string, format: string) =>
  extract(new Uint8Array(readFileSync(new URL(`${format}/${name}.${format}`, corpus))), {
    filename: `${name}.${format}`,
  });

describe('ODP and PPTX parity', () => {
  it.each(['deck-12-slides', 'deck-groups-table', 'deck-hidden-notes', 'deck-slide-order'])(
    '%s gives the same slides from the LibreOffice PPTX and ODP exports',
    async (name) => {
      const [pptx, odp] = await Promise.all([read(name, 'pptx'), read(name, 'odp')]);
      expect(odp.format).toBe('odp');
      expect(comparable(odp.blocks)).toEqual(comparable(pptx.blocks));
      // The ODF manifest warning is #218; every other warning matches.
      expect(odp.warnings.filter((warning) => !warning.message.startsWith('ODF manifest'))).toEqual(
        pptx.warnings,
      );
    },
  );
});

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

describe('XLSB and XLSX parity', () => {
  it.each([
    'workbook-values-formulas',
    'workbook-hidden-sparse',
    'workbook-merged-richstrings',
    'workbook-1904-note',
  ])('%s gives the same sheets and tables as the XLSX it was written from', async (name) => {
    const [xlsx, xlsb] = await Promise.all([read(name, 'xlsx'), read(name, 'xlsb')]);
    expect(xlsb.format).toBe('xlsb');
    expect(comparable(xlsb.blocks)).toEqual(comparable(xlsx.blocks));
    expect(xlsb.warnings).toEqual(xlsx.warnings);
  });
});

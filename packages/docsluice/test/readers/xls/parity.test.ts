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

describe('XLS and XLSX parity', () => {
  it.each([
    'workbook-values-formulas',
    'workbook-hidden-sparse',
    'workbook-merged-richstrings',
    'workbook-1904-note',
  ])('%s gives the same sheets and tables from the LibreOffice XLSX and XLS exports', async (name) => {
    const [xlsx, xls] = await Promise.all([read(name, 'xlsx'), read(name, 'xls')]);
    expect(xls.format).toBe('xls');
    const expected = comparable(xlsx.blocks) as Array<{
      blocks: Array<{ rows: Array<Array<{ address: string }>> }>;
    }>;
    if (name === 'workbook-hidden-sparse') {
      // BIFF8 ends at row 65,536, so LibreOffice's XLS export drops the cell at Z90000.
      for (const section of expected)
        section.blocks = section.blocks.filter((table) => table.rows[0]?.[0]?.address !== 'Z90000');
    }
    expect(comparable(xls.blocks)).toEqual(expected);
    expect(xls.warnings).toEqual(xlsx.warnings);
  });
});

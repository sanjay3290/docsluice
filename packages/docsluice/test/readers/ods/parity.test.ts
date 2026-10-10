import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../../src/core/extract.js';
import type { Block, Cell } from '../../../src/core/model.js';

const corpus = new URL('../../../../../corpus/', import.meta.url);

/** Blocks without locations, which name different parts in the two packages. */
function comparable(blocks: Block[]): Block[] {
  return JSON.parse(
    JSON.stringify(blocks, (key: string, value: unknown) => (key === 'loc' ? undefined : value)),
  ) as Block[];
}

function cells(blocks: Block[]): Cell[] {
  return blocks.flatMap((section) =>
    section.kind === 'section'
      ? section.blocks.flatMap((block) => (block.kind === 'table' ? block.rows.flat() : []))
      : [],
  );
}

const read = (name: string, format: string) =>
  extract(new Uint8Array(readFileSync(new URL(`${format}/${name}.${format}`, corpus))), {
    filename: `${name}.${format}`,
  });

describe('ODS and XLSX parity', () => {
  it.each([
    'workbook-values-formulas',
    'workbook-hidden-sparse',
    'workbook-merged-richstrings',
    'workbook-1904-note',
  ])('%s gives the same sheets and tables from the LibreOffice XLSX and ODS exports', async (name) => {
    const [xlsx, ods] = await Promise.all([read(name, 'xlsx'), read(name, 'ods')]);
    expect(ods.format).toBe('ods');
    const expected = comparable(xlsx.blocks);
    const actual = comparable(ods.blocks);
    // A date cell's raw is the ISO date ODS stores (office:date-value); XLSX stores a serial number.
    const expectedCells = cells(expected);
    cells(actual).forEach((cell, index) => {
      if (typeof cell.raw === 'string' && /^\d{4}-\d\d-\d\d$/.test(cell.raw)) {
        expect(typeof expectedCells[index]?.raw).toBe('number');
        delete expectedCells[index]!.raw;
        delete cell.raw;
      }
    });
    expect(actual).toEqual(expected);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { extract } from '../../../src/core/extract.js';
import type { Block } from '../../../src/core/model.js';
import { defaultRegistry } from '../../../src/core/registry.js';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../../corpus/${name}`, import.meta.url)));

/** Blocks without locations; the packages differ only in their macro parts. */
const comparable = (blocks: Block[]) =>
  JSON.parse(
    JSON.stringify(blocks, (key: string, value: unknown) => (key === 'loc' ? undefined : value)),
  ) as unknown;

describe('macro-enabled Office files', () => {
  it.each([
    [
      'docm',
      'docx/headings-outline-macros.docm',
      'docx/headings-outline.docx',
      'application/vnd.ms-word.document.macroEnabled.12',
    ],
    [
      'xlsm',
      'xlsx/workbook-values-formulas-macros.xlsm',
      'xlsx/workbook-values-formulas.xlsx',
      'application/vnd.ms-excel.sheet.macroEnabled.12',
    ],
    [
      'pptm',
      'pptx/deck-hidden-notes-macros.pptm',
      'pptx/deck-hidden-notes.pptx',
      'application/vnd.ms-powerpoint.presentation.macroEnabled.12',
    ],
  ])(
    'reads %s like its plain version and flags the macros',
    async (format, macroFile, plainFile, mimeType) => {
      const [macros, plain] = await Promise.all([extract(corpus(macroFile)), extract(corpus(plainFile))]);
      expect(macros.format).toBe(format);
      expect(macros.mimeType).toBe(mimeType);
      expect(comparable(macros.blocks)).toEqual(comparable(plain.blocks));
      expect(macros.features).toEqual({ ...plain.features, hasMacros: true });
      expect(macros.warnings).toEqual([
        { code: 'MACROS_PRESENT', message: 'The document contains macros; they were not executed.' },
        ...plain.warnings,
      ]);
    },
  );

  it('registers the macro-enabled ids with the plain readers', async () => {
    const [docm, docx, xlsm, xlsx, pptm, pptx] = await Promise.all(
      (['docm', 'docx', 'xlsm', 'xlsx', 'pptm', 'pptx'] as const).map(
        (id) => defaultRegistry.load(id) ?? Promise.reject(new Error(`No reader for ${id}`)),
      ),
    );
    expect(docm).toBe(docx);
    expect(xlsm).toBe(xlsx);
    expect(pptm).toBe(pptx);
  });

  it('trusts the content over a plain extension, with a format mismatch warning', async () => {
    const doc = await extract(corpus('docx/headings-outline-macros.docm'), { filename: 'renamed.docx' });
    expect(doc.format).toBe('docm');
    expect(doc.warnings.map((warning) => warning.code)).toContain('FORMAT_MISMATCH');
  });
});

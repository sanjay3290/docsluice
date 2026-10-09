import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExtractor } from '../../../src/core/extract.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import type { Reader } from '../../../src/core/reader.js';
import { toJSON, toMarkdown } from '../../../src/index.js';
import { pptReader } from '../../../src/readers/ppt/index.js';
import { xlsReader } from '../../../src/readers/xls/index.js';
import { xlsbReader } from '../../../src/readers/xlsb/index.js';
import { pptxReader } from '../../../src/readers/pptx/index.js';
import { xlsxReader } from '../../../src/readers/xlsx/index.js';

const readers: readonly Reader[] = [pptReader, xlsReader, xlsbReader, pptxReader, xlsxReader];

function extractor() {
  const registry = new ReaderRegistry();
  for (const reader of readers) {
    registry.add({ id: reader.id, mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
  }
  return createExtractor(registry);
}

const cases = [
  {
    format: 'ppt',
    fixture: '../../../../../corpus/ppt/order-title-notes.ppt',
    text: 'TEN FIRST',
  },
  {
    format: 'pptx',
    fixture: '../../../../../corpus/pptx/pptx-lo-edge-cases.pptx',
    text: 'Bar series',
  },
  {
    format: 'xls',
    fixture: '../../../../../corpus/xls/biff8-source.xls',
    text: 'Visible',
  },
  {
    format: 'xlsb',
    fixture: '../xlsb/fixtures/reader-edgecases.xlsb',
    text: 'Alpha',
  },
  {
    format: 'xlsx',
    fixture: '../xlsx/fixtures/basics_order_states_strings_types_merges.xlsx',
    text: 'plain shared text',
  },
] as const;

const pipelineCases = cases.flatMap((testCase) => [
  { ...testCase, dispatch: 'automatic' as const },
  { ...testCase, dispatch: 'explicit' as const },
]);

describe('package D readers through the extraction/rendering pipeline', () => {
  it.each(pipelineCases)(
    'extracts and renders $format with $dispatch dispatch using an injected registry',
    async (testCase) => {
      const bytes = new Uint8Array(readFileSync(new URL(testCase.fixture, import.meta.url)));
      const document = await extractor()(
        bytes,
        testCase.dispatch === 'explicit' ? { format: testCase.format } : {},
      );

      expect(document.format).toBe(testCase.format);
      expect(document.mimeType).toBe(readers.find((reader) => reader.id === testCase.format)?.mimeTypes[0]);
      expect(document.stats.truncated).toBe(false);
      const json = JSON.parse(toJSON(document)) as { format: string; blocks: unknown[] };
      expect(json).toMatchObject({ format: testCase.format });
      expect(json.blocks.length).toBeGreaterThan(0);
      expect(toMarkdown(document)).toContain(testCase.text);
    },
  );

  it('emits XLSX table captions, hidden cells, and comments with metadata-aware authors', async () => {
    const bytes = new Uint8Array(
      readFileSync(
        new URL('../xlsx/fixtures/headers_comments_hidden_tables_defined_names.xlsx', import.meta.url),
      ),
    );
    const document = await extractor()(bytes);
    const sheet = document.blocks.find((block) => block.kind === 'section');
    if (sheet?.kind !== 'section') throw new Error('Expected an extracted worksheet section.');
    expect(sheet.title).toBe('Features');

    const table = sheet.blocks.find((block) => block.kind === 'table');
    if (table?.kind !== 'table') throw new Error('Expected a worksheet table.');
    expect(table).toMatchObject({ caption: 'FeatureTable', headerRows: 1, loc: { range: 'A1:B3' } });
    const cells = table.rows.flat();
    expect(cells.find((cell) => cell.address === 'B1')?.hidden).toBe(true);
    expect(cells.find((cell) => cell.address === 'A3')?.hidden).toBe(true);

    const note = sheet.blocks.find((block) => block.kind === 'note');
    expect(note).toMatchObject({
      kind: 'note',
      role: 'comment',
      text: 'Self-authored note text.',
      author: 'Fixture Author',
      loc: { sheet: 'Features', range: 'A2' },
    });
    expect(toMarkdown(document)).toContain('FeatureTable');
    expect(toMarkdown(document)).toContain('Self-authored note text.');

    const withoutMetadata = await extractor()(bytes, { metadata: false });
    const privateSheet = withoutMetadata.blocks.find((block) => block.kind === 'section');
    if (privateSheet?.kind !== 'section') throw new Error('Expected a worksheet section without metadata.');
    const privateNote = privateSheet.blocks.find((block) => block.kind === 'note');
    expect(privateNote).toMatchObject({ text: 'Self-authored note text.', loc: { range: 'A2' } });
    expect(privateNote).not.toHaveProperty('author');
  });
});

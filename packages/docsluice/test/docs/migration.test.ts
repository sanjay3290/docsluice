/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ingestForModel, redactBlock } from '../../examples/migration/ingest.js';
import type { Block } from '../../src/index.js';

describe('migration example', () => {
  it('runs the example against the registered legacy DOC reader', async () => {
    const bytes = new Uint8Array(
      await readFile(new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url)),
    );
    const result = await ingestForModel(bytes, 'example.doc');
    expect(result.document.format).toBe('doc');
    expect(result.document.metadata).toEqual({});
    expect(result.markdown).toContain('# Legacy Word fixture');
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.document.stats.truncated).toBe(false);
  });

  it('masks paragraphs and inline runs without changing citation locations or the input', () => {
    const block: Block = {
      kind: 'paragraph',
      text: 'Email pat@example.test; ID 123-45-6789',
      runs: [{ text: 'pat@example.test', href: 'mailto:pat@example.test' }],
      loc: { page: 2 },
    };
    const redacted = redactBlock(block);
    expect(redacted).toEqual({ kind: 'paragraph', text: 'Email [email]; ID [id]', loc: { page: 2 } });
    expect(block.text).toContain('pat@example.test');
    expect(redacted.loc).toEqual({ page: 2 });
  });

  it('removes runs that split sensitive content and unrendered table values', () => {
    const paragraph: Block = {
      kind: 'paragraph',
      text: 'pat@example.test',
      runs: [{ text: 'pat@' }, { text: 'example.test' }],
      loc: {},
    };
    expect(redactBlock(paragraph)).toEqual({ kind: 'paragraph', text: '[email]', loc: {} });
    const table: Block = {
      kind: 'table',
      rows: [[{ text: '123-45-6789', raw: 123456789, formula: '123456789' }]],
      headerRows: 0,
      loc: {},
    };
    expect(redactBlock(table)).toEqual({ ...table, rows: [[{ text: '[id]' }]] });
  });

  it('masks nested list items, table cells and labels used by Markdown', () => {
    const blocks: Block[] = [
      {
        kind: 'list',
        ordered: false,
        items: [{ text: 'pat@example.test', items: [{ text: '123-45-6789' }] }],
        loc: {},
      },
      {
        kind: 'table',
        rows: [[{ text: 'pat@example.test', raw: 'pat@example.test', formula: 'pat@example.test' }]],
        caption: '123-45-6789',
        headerRows: 0,
        loc: {},
      },
      { kind: 'image', alt: 'pat@example.test', loc: {} },
      {
        kind: 'section',
        role: 'page',
        title: 'pat@example.test',
        blocks: [{ kind: 'paragraph', text: '123-45-6789', loc: {} }],
        loc: {},
      },
    ];
    for (const block of blocks) {
      const result = JSON.stringify(redactBlock(block));
      expect(result).not.toContain('pat@example.test');
      expect(result).not.toContain('123-45-6789');
    }
  });

  it('keeps the guide code in a tested example instead of unexecuted TypeScript fences', async () => {
    const guide = await readFile(new URL('../../../../docs/guides/migration.md', import.meta.url), 'utf8');
    expect(guide).toContain('packages/docsluice/examples/migration/ingest.ts');
    expect(guide).not.toMatch(/```(?:ts|typescript)\b/);
    for (const name of ['SheetJS', 'pdf-parse', 'mammoth', 'adm-zip', 'yauzl']) expect(guide).toContain(name);
  });
});

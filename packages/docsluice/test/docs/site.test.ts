/// <reference types="node" />
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Block, DocsluiceDocument } from '../../src/index.js';
import { ingestForSearch } from '../../examples/site/rag.js';
import { extractUploadedFile } from '../../examples/site/upload.js';
import { redactBlock } from '../../examples/site/redaction.js';
import { routeForOcr } from '../../examples/site/ocr.js';

const docFixture = new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url);

describe('documentation examples', () => {
  it('runs the RAG ingestion recipe through the built-in DOC reader', async () => {
    const bytes = new Uint8Array(await readFile(docFixture));
    const result = await ingestForSearch(bytes, 'sample.doc');
    expect(result.document.format).toBe('doc');
    expect(result.markdown).toContain('Legacy Word fixture');
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it('accepts a browser File and applies bounded, privacy-aware extraction', async () => {
    const bytes = await readFile(docFixture);
    const file = new File([bytes], 'sample.doc', { type: 'application/msword' });
    const document = await extractUploadedFile(file);
    expect(document.format).toBe('doc');
    expect(document.metadata).toEqual({});
    expect(document.blocks.length).toBeGreaterThan(0);
  });

  it('rejects an oversized upload before reading its body into memory', async () => {
    await expect(extractUploadedFile({ size: 25_000_001 } as File)).rejects.toThrow('25 MB');
  });

  it('redacts body, headings, list/table surfaces without mutating the source block', () => {
    const block: Block = {
      kind: 'section',
      role: 'page',
      title: 'pat@example.test',
      loc: {},
      blocks: [
        {
          kind: 'paragraph',
          text: 'Email pat@example.test and ID 123-45-6789',
          loc: {},
          runs: [{ text: 'pat@example.test', href: 'mailto:pat@example.test' }],
        },
        {
          kind: 'table',
          headerRows: 0,
          loc: {},
          rows: [[{ text: '123-45-6789', raw: 'pat@example.test', formula: 'pat@example.test' }]],
        },
        {
          kind: 'list',
          ordered: false,
          loc: {},
          items: [{ text: 'pat@example.test', items: [{ text: '123-45-6789' }] }],
        },
      ],
    };
    const redacted = redactBlock(block);
    expect(JSON.stringify(redacted)).not.toContain('pat@example.test');
    expect(JSON.stringify(redacted)).not.toContain('123-45-6789');
    expect(JSON.stringify(block)).toContain('pat@example.test');
  });

  it('routes OCR only when extraction reports it is needed', () => {
    const base = {
      format: 'pdf',
      mimeType: 'application/pdf',
      metadata: {},
      features: {
        hasMacros: false,
        hasExternalLinks: false,
        hasEmbeddedFiles: false,
        isEncrypted: false,
        hasJavaScript: false,
      },
      blocks: [],
      children: [],
      warnings: [],
      stats: { bytesRead: 4, durationMs: 0, truncated: false, needsOcr: true },
    } satisfies DocsluiceDocument;
    expect(routeForOcr(base)).toEqual({ action: 'ocr', reason: 'text-layer-missing' });
    expect(routeForOcr({ ...base, stats: { ...base.stats, needsOcr: false } })).toEqual({ action: 'skip' });
  });
});

describe('generated limits page', () => {
  it('matches DEFAULT_LIMITS exported by the built public package', async () => {
    const { DEFAULT_LIMITS } = await import('../../dist/index.js');
    const generated = await readFile(
      new URL('../../../../docs/site/reference/limits.md', import.meta.url),
      'utf8',
    );
    const rows = [...generated.matchAll(/^\| `([^`]+)` \| ([\d,]+) \|$/gm)].map(([, key, value]) => [
      key,
      Number(value?.replaceAll(',', '')),
    ]);
    expect(rows).toEqual(Object.entries(DEFAULT_LIMITS));
    expect(generated).toContain('inputBytes');
    expect(generated).toContain('timeMs');
  });
});

describe('documentation examples', () => {
  it('links to tested source modules on the published branch instead of showing TypeScript snippets', async () => {
    const pages = await Promise.all(
      ['quickstart.md', 'recipes/rag.md', 'recipes/redaction.md', 'recipes/upload.md', 'recipes/ocr.md'].map(
        (page) => readFile(new URL(`../../../../docs/site/${page}`, import.meta.url), 'utf8'),
      ),
    );
    for (const page of pages) expect(page).not.toMatch(/```(?:ts|typescript)\b/);
    const links = pages.flatMap((page) =>
      page
        .split('](')
        .slice(1)
        .map((part) => part.split(')', 1)[0])
        .filter((link): link is string => link !== undefined),
    );
    const sourceLinks = links.filter(
      (link) =>
        link.includes('/packages/docsluice/examples/site/') ||
        link.includes('/packages/docsluice/test/docs/site.test.ts'),
    );
    expect(sourceLinks.length).toBeGreaterThanOrEqual(9);
    for (const link of sourceLinks) {
      expect(link.startsWith('https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/')).toBe(
        true,
      );
    }
    expect(sourceLinks).toContain(
      'https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/rag.ts',
    );
    expect(sourceLinks).toContain(
      'https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/redaction.ts',
    );
    expect(sourceLinks).toContain(
      'https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/upload.ts',
    );
    expect(sourceLinks).toContain(
      'https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/ocr.ts',
    );
  });
});

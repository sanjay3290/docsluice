import Ajv2020 from 'ajv/dist/2020.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extract } from '../../src/index.js';
import { toJSON } from '../../src/render/json.js';
import type { DocsluiceDocument } from '../../src/core/model.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const runtimeProcess = (
  globalThis as typeof globalThis & { process: { env: Record<string, string | undefined> } }
).process;
const packageVersion = (
  JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version: string }
).version;
const schema = JSON.parse(readFileSync(join(packageRoot, 'schema.json'), 'utf8')) as object;
const blockSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $ref: '#/$defs/Block',
  $defs: (schema as { $defs: Record<string, unknown> }).$defs,
};

function goldenFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return goldenFiles(path);
    return entry.name.endsWith('.expected.json') ? [path] : [];
  });
}

function sampleDocument(): DocsluiceDocument {
  return {
    format: 'pdf',
    mimeType: 'application/pdf',
    metadata: {
      title: 'Schema sample',
      authors: ['Ada'],
      custom: [{ name: 'department', value: 'Research' }],
    },
    features: {
      hasMacros: false,
      hasExternalLinks: true,
      hasEmbeddedFiles: false,
      isEncrypted: false,
      hasJavaScript: false,
    },
    blocks: [
      { kind: 'heading', level: 1, text: 'Title', loc: { page: 1, offset: [0, 5] } },
      { kind: 'paragraph', text: 'Body', runs: [{ text: 'Body', bold: true }], loc: {} },
      {
        kind: 'list',
        ordered: true,
        items: [{ text: 'First', marker: '1.', items: [{ text: 'Nested' }] }],
        loc: {},
      },
      {
        kind: 'table',
        rows: [
          [
            { text: 'text', raw: 'text' },
            { text: 'number', raw: 3 },
            { text: 'boolean', raw: true },
            { text: 'null', raw: null },
          ],
        ],
        headerRows: 1,
        caption: 'Values',
        loc: {},
      },
      { kind: 'code', language: 'ts', text: 'const value = 1;', loc: {} },
      {
        kind: 'image',
        alt: 'Chart',
        mimeType: 'image/png',
        ref: 'child/image.png',
        width: 100,
        height: 50,
        loc: {},
      },
      { kind: 'note', role: 'comment', text: 'Review', author: 'Ada', loc: {} },
      { kind: 'header', text: 'Header', loc: {} },
      { kind: 'footer', text: 'Footer', loc: {} },
      {
        kind: 'section',
        role: 'sheet',
        title: 'Sheet 1',
        hidden: 'very',
        blocks: [],
        loc: { sheet: 'Sheet 1' },
      },
    ],
    children: [{ path: 'archive/entry.txt', name: 'entry.txt', status: 'listed', sizeBytes: 0 }],
    warnings: [
      { code: 'FORMAT_MISMATCH', message: 'Name and contents differ.', loc: { path: 'archive/entry.txt' } },
    ],
    stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
  };
}

describe('public JSON Schema', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  const validateBlock = ajv.compile(blockSchema);

  it('identifies the 2020-12 dialect and this package major version', () => {
    expect(schema).toMatchObject({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://github.com/sanjay3290/docsluice/schema/v${packageVersion.split('.')[0]}`,
    });
  });

  it('validates every reviewed golden JSON output', () => {
    const files = goldenFiles(join(repositoryRoot, 'corpus'));
    expect(files.length).toBeGreaterThan(0);
    let documentCount = 0;

    for (const file of files) {
      const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
      // The existing DOC parser fixture is a lower-level block array, not JSON
      // emitted by toJSON(). Its entries intentionally predate public Block locs.
      if (Array.isArray(value)) continue;
      documentCount++;
      expect(validate(value), file).toBe(true);
    }
    expect(documentCount).toBeGreaterThan(0);
  });

  it('validates a reviewed full-document golden emitted by toJSON()', () => {
    const goldenPath = join(repositoryRoot, 'corpus/model/document.expected.json');
    const golden: unknown = JSON.parse(readFileSync(goldenPath, 'utf8'));
    expect(JSON.parse(toJSON(sampleDocument(), { stable: true }))).toEqual(golden);
    expect(validate(golden), goldenPath).toBe(true);
  });

  it('accepts open plugin format ids', () => {
    const document = sampleDocument();
    document.format = 'custom-plugin-format';

    expect(validate(JSON.parse(toJSON(document, { stable: true })))).toBe(true);
  });

  it('validates and snapshots public extraction of the licensed native DOC fixture', async () => {
    const sourcePath = new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url);
    const goldenPath = join(repositoryRoot, 'corpus/model/doc-legacy.document.expected.json');
    const document = await extract(new Uint8Array(readFileSync(sourcePath)));
    const serialized = `${toJSON(document, { stable: true, space: 2 })}\n`;

    if (runtimeProcess.env.UPDATE_SCHEMA_GOLDEN === '1') {
      writeFileSync(goldenPath, serialized, 'utf8');
    }

    const golden = readFileSync(goldenPath, 'utf8');
    expect(serialized).toBe(golden);
    expect(validate(JSON.parse(serialized)), goldenPath).toBe(true);
  });

  it('validates base64 child bytes when the serializer option includes them', () => {
    const document = sampleDocument();
    document.children[0]!.bytes = Uint8Array.of(1, 2, 3);
    const encoded: unknown = JSON.parse(toJSON(document, { bytes: 'base64' }));

    expect((encoded as { children: Array<{ bytes: string }> }).children[0]?.bytes).toBe('AQID');
    expect(validate(encoded)).toBe(true);
  });

  it('rejects documents missing required model fields', () => {
    const document = JSON.parse(toJSON(sampleDocument())) as Record<string, unknown>;
    delete document.stats;

    expect(validate(document)).toBe(false);
  });

  it('enforces discriminated block unions and literal ranges', () => {
    const document = JSON.parse(toJSON(sampleDocument())) as Record<string, unknown>;
    document.blocks = [{ kind: 'heading', level: 7, text: 'Title', loc: {} }];

    expect(validate(document)).toBe(false);
  });

  it('rejects invalid cell unions', () => {
    const document = JSON.parse(toJSON(sampleDocument())) as Record<string, unknown>;
    document.blocks = [
      {
        kind: 'table',
        rows: [[{ text: 'value', raw: { value: 'not JSON model data' } }]],
        headerRows: 0,
        loc: {},
      },
    ];

    expect(validate(document)).toBe(false);
  });

  it('validates every variant in the existing low-level DOC block golden', () => {
    const parserGoldenPath = join(repositoryRoot, 'corpus/doc/doc-legacy.doc.expected.json');
    const parserGolden = JSON.parse(readFileSync(parserGoldenPath, 'utf8')) as Array<Record<string, unknown>>;
    expect(parserGolden.length).toBeGreaterThan(0);
    // This parser fixture predates the public builder's loc and headerRows fields.
    const publicBlocks = parserGolden.map((block) => ({
      ...block,
      ...(block.kind === 'table' ? { headerRows: 0 } : {}),
      loc: {},
    }));
    for (const block of publicBlocks) expect(validateBlock(block), parserGoldenPath).toBe(true);
  });

  it('does not accept unknown serialized model fields', () => {
    const document = JSON.parse(toJSON(sampleDocument())) as Record<string, unknown>;
    document.unmodeled = true;

    expect(validate(document)).toBe(false);
  });
});

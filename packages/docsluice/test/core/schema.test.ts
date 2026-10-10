import { readdirSync, readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { extract } from '../../src/core/extract.js';
import { toJSON } from '../../src/render/json.js';
import { generateSchema } from '../../scripts/generate-schema.mjs';

const corpus = new URL('../../../../corpus/', import.meta.url);
const schema = generateSchema();
// `type: [...]` unions are standard JSON Schema; Ajv only asks to allow them in strict mode.
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(schema);
const errors = () => ajv.errorsText(validate.errors, { separator: '\n' });

// Every reviewed golden document, sidecars included (`.revisions.expected.json`, `.runs.expected.json`…).
const goldens = readdirSync(corpus, { recursive: true })
  .map((name) => String(name).replaceAll('\\', '/'))
  .filter((name) => name.endsWith('.expected.json'))
  .sort();

describe('JSON Schema of the output model (MOD-2)', () => {
  it('names the model major version and has a definition for every model type', () => {
    expect(schema.$id).toBe('urn:docsluice:schema:document:v0');
    expect(Object.keys(schema.$defs)).toEqual(
      expect.arrayContaining([
        'DocsluiceDocument',
        'Block',
        'SectionBlock',
        'Cell',
        'Location',
        'ChildDocument',
      ]),
    );
  });

  it('finds the golden files', () => {
    expect(goldens.length).toBeGreaterThan(100);
  });

  it.each(goldens)('%s validates', (name) => {
    const document: unknown = JSON.parse(readFileSync(new URL(name, corpus), 'utf8'));
    expect(validate(document), errors()).toBe(true);
  });

  it('validates child bytes as base64 and every option-dependent field', async () => {
    const zip = new Uint8Array(readFileSync(new URL('zip/bundle.zip', corpus)));
    const doc = await extract(zip, { childBytes: true, runs: true, formulas: true });
    const document: unknown = JSON.parse(toJSON(doc, { bytes: 'base64' }));
    expect(validate(document), errors()).toBe(true);
  });

  it('rejects documents that do not follow the model', async () => {
    const doc = JSON.parse(
      toJSON(await extract(new TextEncoder().encode('# Title\n\nText.'), { filename: 'a.md' })),
    ) as {
      blocks: Array<Record<string, unknown>>;
      stats: Record<string, unknown>;
      extra?: boolean;
    };
    expect(validate(doc), errors()).toBe(true);
    const variants: Array<(copy: typeof doc) => void> = [
      (copy) => (copy.blocks[0]!.kind = 'banner'),
      (copy) => (copy.blocks[0]!.level = 7),
      (copy) => delete copy.blocks[1]!.loc,
      (copy) => (copy.blocks[1]!.surprise = true),
      (copy) => (copy.extra = true),
      (copy) => (copy.stats.truncated = 'no'),
      (copy) => (copy.blocks[1]!.loc = { offset: [1] }),
    ];
    for (const change of variants) {
      const copy = structuredClone(doc);
      change(copy);
      expect(validate(copy)).toBe(false);
    }
  });

  it('accepts format ids and warning codes the model does not list (plugins)', () => {
    const plugin = {
      format: 'x-tally',
      mimeType: 'application/x-tally',
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
      warnings: [{ code: 'X_PLUGIN_NOTE', message: 'A plugin warning.' }],
      stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
    };
    expect(validate(plugin), errors()).toBe(true);
  });
});

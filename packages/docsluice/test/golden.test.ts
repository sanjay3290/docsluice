import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extract } from '../src/core/extract.js';
import { toJSON } from '../src/render/json.js';
import { toMarkdown } from '../src/render/markdown.js';

// Golden runner (QA-2, docs/testing.md section 2). `UPDATE_GOLDEN=1 npm test` rewrites expected files.
const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const root = new URL('../../../corpus/', import.meta.url);
const SIDECARS = ['.license', '.expected.json', '.expected.md', '.blocks.json', '.native.txt'];
const METADATA = new Set(['README.md', '.gitattributes']);
const INSTRUCTIONS =
  'Review the output, then run `UPDATE_GOLDEN=1 npm test` locally and commit the expected files.';

const inputs = readdirSync(root, { recursive: true })
  .map((name) => name.replaceAll('\\', '/'))
  .filter((name) => {
    const base = name.slice(name.lastIndexOf('/') + 1);
    return name.includes('/') && base.includes('.') && !METADATA.has(base);
  })
  .filter((name) => !SIDECARS.some((suffix) => name.endsWith(suffix)))
  .sort();

function hasSpdxLicense(input: string): boolean {
  const license = new URL(`${input}.license`, root);
  if (!existsSync(license)) return false;
  return readFileSync(license, 'utf8')
    .split('\n')
    .some((line) => line.startsWith('SPDX-License-Identifier:') && line.slice(24).trim().length > 0);
}

describe('golden corpus', () => {
  it('finds corpus inputs', () => {
    expect(inputs.length).toBeGreaterThan(0);
  });

  it.each(inputs)('%s has an SPDX .license and matches its reviewed output', async (input) => {
    expect(hasSpdxLicense(input), `${input} needs a .license file with an SPDX-License-Identifier line`).toBe(
      true,
    );
    const jsonPath = new URL(`${input}.expected.json`, root);
    const markdownPath = new URL(`${input}.expected.md`, root);
    const bytes = new Uint8Array(readFileSync(new URL(input, root)));
    const name = input.slice(input.lastIndexOf('/') + 1);
    let doc;
    try {
      doc = await extract(bytes, { filename: name });
    } catch (error) {
      // A corpus file for a format without a reader yet. Adding the reader makes this fail until goldens exist.
      expect((error as { code?: string }).code, `${input} failed to extract`).toBe('UNSUPPORTED_FORMAT');
      expect(existsSync(jsonPath) || existsSync(markdownPath), `${input} has goldens but no reader`).toBe(
        false,
      );
      return;
    }
    const json = toJSON(doc, { stable: true });
    const markdown = toMarkdown(doc);
    if (update) {
      writeFileSync(jsonPath, json);
      writeFileSync(markdownPath, markdown);
      return;
    }
    expect(
      existsSync(jsonPath) && existsSync(markdownPath),
      `${input} has no expected files. ${INSTRUCTIONS}`,
    ).toBe(true);
    expect(json, `${input}.expected.json differs. ${INSTRUCTIONS}`).toBe(readFileSync(jsonPath, 'utf8'));
    expect(markdown, `${input}.expected.md differs. ${INSTRUCTIONS}`).toBe(
      readFileSync(markdownPath, 'utf8'),
    );
  });
});

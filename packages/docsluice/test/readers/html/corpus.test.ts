import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { extract } from '../../../src/core/extract.js';
import { toJSON } from '../../../src/render/json.js';
import { toMarkdown } from '../../../src/render/markdown.js';

// Reviewed HTML corpus outputs, checked here until the shared golden runner (#21) lands.
const directory = new URL('../../../../../corpus/html/', import.meta.url);
const pages = readdirSync(directory).filter((name) => name.endsWith('.html'));

describe('HTML corpus', () => {
  it.each(pages)('%s matches its reviewed JSON and Markdown', async (name) => {
    const doc = await extract(new Uint8Array(readFileSync(new URL(name, directory))), { filename: name });
    doc.stats.durationMs = 0;
    expect(toJSON(doc)).toBe(readFileSync(new URL(`${name}.expected.json`, directory), 'utf8'));
    expect(toMarkdown(doc)).toBe(readFileSync(new URL(`${name}.expected.md`, directory), 'utf8'));
  });
});

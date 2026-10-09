import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../src/core/extract.js';

interface ManifestEntry {
  file: string;
  expect: { warnings?: string[]; error?: string };
  maxMs: number;
}

const root = new URL('../../../../hostile/', import.meta.url);
const entries = (JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as ManifestEntry[]).filter(
  ({ file }) => file.startsWith('markdown/') || file.startsWith('txt/'),
);

describe('hostile TXT and Markdown samples', () => {
  it('lists at least one sample per reader', () => {
    expect(entries.some(({ file }) => file.startsWith('markdown/'))).toBe(true);
    expect(entries.some(({ file }) => file.startsWith('txt/'))).toBe(true);
  });

  for (const entry of entries) {
    it(`${entry.file} meets its manifest expectation`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(entry.file, root)));
      const started = performance.now();
      const doc = await extract(bytes, { filename: entry.file.split('/').at(-1) });
      expect(performance.now() - started).toBeLessThan(entry.maxMs);
      expect(doc.format).toBe(entry.file.split('/')[0]);
      expect(doc.warnings.map(({ code }) => code)).toEqual(entry.expect.warnings);
    });
  }
});

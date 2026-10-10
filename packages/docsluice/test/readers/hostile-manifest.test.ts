import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract } from '../../src/core/extract.js';
import type { FormatId } from '../../src/core/model.js';

interface ManifestEntry {
  file: string;
  format?: FormatId;
  expect: { warnings?: string[]; error?: string };
  maxMs: number;
}

// Manifest entries for these readers run here until the shared hostile runner (#20) lands.
const READERS = ['markdown', 'txt', 'csv', 'tsv', 'json', 'xml', 'html'];
const root = new URL('../../../../hostile/', import.meta.url);
const entries = (JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as ManifestEntry[]).filter(
  ({ file }) => READERS.includes(file.split('/')[0]!),
);

describe('hostile samples for the text readers', () => {
  it('lists at least one sample per reader', () => {
    for (const reader of READERS)
      expect(entries.some(({ file }) => file.startsWith(`${reader}/`))).toBe(true);
  });

  for (const entry of entries) {
    it(`${entry.file} meets its manifest expectation`, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(entry.file, root)));
      const started = performance.now();
      const doc = await extract(bytes, {
        filename: entry.file.split('/').at(-1),
        ...(entry.format ? { format: entry.format } : {}),
      });
      expect(performance.now() - started).toBeLessThan(entry.maxMs);
      expect(doc.format).toBe(entry.file.split('/')[0]);
      expect(doc.warnings.map(({ code }) => code)).toEqual(entry.expect.warnings);
      expect(Object.keys(Object.prototype)).toEqual([]);
    });
  }
});

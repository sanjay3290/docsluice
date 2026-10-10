import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { extract } from '../src/core/extract.js';
import type { FormatId } from '../src/core/model.js';

/** One `hostile/manifest.json` entry (docs/testing.md, section 3). */
interface ManifestEntry {
  file: string;
  /** Forces a reader for attack files that detection routes elsewhere. */
  format?: FormatId;
  /** The `password` option, for encrypted attack files that must be opened to reach the payload. */
  password?: string;
  expect: { error: string } | { warnings: string[] };
  maxMs: number;
  maxHeapMB: number;
  requirement: string;
}

const root = new URL('../../../hostile/', import.meta.url);
const entries = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as ManifestEntry[];
const ownKeys = (target: object): string[] => Reflect.ownKeys(target).map(String).sort();
const objectKeys = ownKeys(Object.prototype);
const arrayKeys = ownKeys(Array.prototype);

describe('hostile corpus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists every hostile file exactly once and only existing files', () => {
    const files = readdirSync(root, { recursive: true })
      .map((name) => name.replaceAll('\\', '/'))
      .filter((name) => name.includes('/') && !name.endsWith('.license') && !name.endsWith('/.gitattributes'))
      .filter((name) => name.slice(name.lastIndexOf('/') + 1).includes('.'))
      .sort();
    const listed = entries.map(({ file }) => file).sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(files);
  });

  it.each(entries.map((entry) => [entry.file, entry] as const))(
    '%s meets its manifest expectation',
    async (_file, entry) => {
      const fetch = vi.fn(() => {
        throw new Error('docsluice must never fetch');
      });
      vi.stubGlobal('fetch', fetch);
      const bytes = new Uint8Array(readFileSync(new URL(entry.file, root)));
      const options = {
        filename: entry.file.slice(entry.file.lastIndexOf('/') + 1),
        ...(entry.format ? { format: entry.format } : {}),
        ...(entry.password !== undefined ? { password: entry.password } : {}),
      };
      const started = performance.now();
      let outcome: { error: string } | { warnings: string[] };
      try {
        const doc = await extract(bytes, options);
        outcome = { warnings: doc.warnings.map(({ code }) => code) };
      } catch (error) {
        outcome = { error: (error as { code?: string }).code ?? String(error) };
      }
      expect(performance.now() - started).toBeLessThan(entry.maxMs);
      expect(outcome).toEqual(entry.expect);
      expect(fetch).not.toHaveBeenCalled();
      expect(ownKeys(Object.prototype)).toEqual(objectKeys);
      expect(ownKeys(Array.prototype)).toEqual(arrayKeys);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );
});

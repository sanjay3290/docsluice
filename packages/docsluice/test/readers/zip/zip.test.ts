import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { extract } from '../../../src/core/extract.js';
import type { ChildDocument } from '../../../src/core/model.js';
import { zipReader } from '../../../src/readers/zip/index.js';

const root = new URL('../../../../../', import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
const summary = (children: ChildDocument[]) =>
  children.map((child) => [child.path, child.status, child.error?.code ?? null]);

describe('ZIP container reader', () => {
  it('is registered for plain ZIP archives and has no blocks of its own', async () => {
    expect(zipReader.id).toBe('zip');
    const doc = await extract(read('corpus/zip/bundle.zip'));
    expect(doc.format).toBe('zip');
    expect(doc.blocks).toEqual([]);
  });

  it('keeps central-directory order and child paths, and skips directories (NST-3)', async () => {
    const doc = await extract(read('corpus/zip/bundle.zip'));
    expect(summary(doc.children)).toEqual([
      ['data/', 'skipped', null],
      ['data/readings.csv', 'extracted', null],
      ['page.html', 'extracted', null],
      ['inner.zip', 'extracted', null],
      ['pixel.png', 'extracted', null],
    ]);
    const inner = doc.children[3]!.document!;
    expect(inner.children[0]).toMatchObject({ path: 'inner.zip/notes.txt', status: 'extracted' });
    expect(inner.children[0]!.document!.blocks[0]!.loc.path).toBe('inner.zip/notes.txt');
  });

  it('lists entries without reading their data with children: "list"', async () => {
    // Reading this entry would throw LIMIT_EXCEEDED (compression ratio); listing must not inflate it.
    const doc = await extract(read('hostile/zip/bomb-42k.zip'), { children: 'list' });
    expect(doc.children.length).toBeGreaterThan(0);
    expect(doc.children.every((child) => child.status === 'listed' && child.document === undefined)).toBe(
      true,
    );
    expect(doc.children[0]!.sizeBytes).toBeGreaterThan(1_000_000);
    expect(doc.warnings).toEqual([]);
  });

  it('adds no children with children: "skip"', async () => {
    const doc = await extract(read('corpus/zip/bundle.zip'), { children: 'skip' });
    expect(doc.children).toEqual([]);
  });

  it('lists OS junk as skipped and encrypted entries as failed with ENCRYPTED', async () => {
    const doc = await extract(read('hostile/zip/junk-and-encrypted.zip'));
    expect(summary(doc.children)).toEqual([
      ['__MACOSX/._report.txt', 'skipped', null],
      ['.DS_Store', 'skipped', null],
      ['photos/Thumbs.db', 'skipped', null],
      ['secret.txt', 'failed', 'ENCRYPTED'],
      ['report.txt', 'extracted', null],
    ]);
    expect(doc.features.isEncrypted).toBe(true);
  });

  it('shares one budget with children and lists files nested past childDepth (NST-1, NST-2)', async () => {
    const doc = await extract(read('hostile/zip/nested-chain-8.zip'));
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['DEPTH_LIMIT']);
    let depth = 0;
    let current = doc;
    while (current.children[0]?.document) {
      current = current.children[0].document;
      depth++;
    }
    expect(depth).toBe(3);
    expect(current.children[0]!.status).toBe('listed');
  });

  it('reports an entry stopped by the shared uncompressed budget as failed with LIMIT_EXCEEDED', async () => {
    const mtime = new Date('1980-01-01T00:00:00Z');
    const bytes = zipSync({
      'a.txt': [strToU8('a'.repeat(3000)), { mtime, level: 0 }],
      'b.txt': [strToU8('b'.repeat(3000)), { mtime, level: 0 }],
    });
    const doc = await extract(bytes, { limits: { totalUncompressedBytes: 4000 } });
    expect(summary(doc.children)).toEqual([
      ['a.txt', 'extracted', null],
      ['b.txt', 'failed', 'LIMIT_EXCEEDED'],
    ]);
    expect(doc.stats.truncated).toBe(true);
  });

  it('keeps path-traversal names as display paths only', async () => {
    const doc = await extract(read('hostile/zip/path-traversal.zip'));
    expect(summary(doc.children)).toEqual([['etc/passwd', 'extracted', null]]);
  });
});

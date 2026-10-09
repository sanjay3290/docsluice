import { describe, expect, it } from 'vitest';
import { createExtractor } from '../../../src/core/extract.js';
import type { LimitExceededError } from '../../../src/core/errors.js';
import type { Reader } from '../../../src/core/reader.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import { zipReader } from '../../../src/readers/zip/index.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { makeZip, type ZipFixtureEntry } from '../../helpers/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytes = (value: string): Uint8Array => encoder.encode(value);

/** Test-only stand-in for pending text readers; it is not CSV/HTML acceptance. */
const textReader: Reader = {
  id: 'txt',
  mimeTypes: ['text/plain'],
  read(ctx) {
    const text = decoder.decode(ctx.bytes);
    if (text.length > 0) ctx.out.paragraph(text);
    return Promise.resolve();
  },
};

function extractor(...readers: Reader[]) {
  const registry = new ReaderRegistry();
  registry.add({ id: 'zip', mimeTypes: ['application/zip'], load: () => Promise.resolve(zipReader) });
  const textOverride = readers.find((reader) => reader.id === 'txt');
  registry.add({
    id: 'txt',
    mimeTypes: ['text/plain'],
    load: () => Promise.resolve(textOverride ?? textReader),
  });
  for (const reader of readers.filter((item) => item.id !== 'txt')) {
    registry.add({ id: reader.id, mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
  }
  return createExtractor(registry);
}

function blockText(document: { blocks: Array<{ kind: string; text?: string }> } | undefined): string[] {
  return (document?.blocks ?? [])
    .filter((block) => block.kind === 'paragraph')
    .map((block) => block.text ?? '');
}

function corruptFirstDeflatePayload(archive: Uint8Array): Uint8Array {
  const corrupted = archive.slice();
  const view = new DataView(corrupted.buffer, corrupted.byteOffset, corrupted.byteLength);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const compressedStart = 30 + nameLength + extraLength;
  corrupted[compressedStart] = (corrupted[compressedStart] ?? 0) ^ 0xff;
  return corrupted;
}

describe('ZIP reader through the extraction pipeline', () => {
  it('extracts children in central order, cleans traversal paths, and assigns text offsets', async () => {
    const archive = makeZip([
      { name: 'second.txt', data: bytes('second') },
      { name: '../../safe/first.txt', data: bytes('first') },
    ]);

    const document = await extractor()(archive);

    expect(document.format).toBe('zip');
    expect(document.children.map(({ path, name, status }) => [path, name, status])).toEqual([
      ['second.txt', 'second.txt', 'extracted'],
      ['safe/first.txt', 'safe/first.txt', 'extracted'],
    ]);
    expect(blockText(document.children[0]?.document)).toEqual(['second']);
    expect(document.children[0]?.document?.blocks[0]?.loc).toMatchObject({
      path: 'second.txt',
      offset: [0, 6],
    });
    expect(document.children[1]?.document?.blocks[0]?.loc).toMatchObject({
      path: 'safe/first.txt',
      offset: [0, 5],
    });
  });

  it('extracts nested ZIP children with complete paths and offsets', async () => {
    const inner = makeZip([{ name: 'nested/report.txt', data: bytes('nested report') }]);
    const outer = makeZip([{ name: 'folder/inside.zip', data: inner }]);

    const document = await extractor()(outer);
    const nestedZip = document.children[0];
    const report = nestedZip?.document?.children[0];

    expect(nestedZip?.path).toBe('folder/inside.zip');
    expect(nestedZip?.status).toBe('extracted');
    expect(report?.path).toBe('folder/inside.zip/nested/report.txt');
    expect(report?.status).toBe('extracted');
    expect(blockText(report?.document)).toEqual(['nested report']);
    expect(report?.document?.blocks[0]?.loc).toMatchObject({
      path: 'folder/inside.zip/nested/report.txt',
      offset: [0, 13],
    });
  });

  it('shares uncompressed-byte and entry allowances with nested archives', async () => {
    const inner = makeZip([{ name: 'leaf.txt', data: bytes('123456789') }]);
    const outer = makeZip([{ name: 'inner.zip', data: inner }]);
    const extract = extractor();

    const byteLimited = await extract(outer, {
      limits: { totalUncompressedBytes: inner.length + 1 },
    });
    const innerDocument = byteLimited.children[0]?.document;
    expect(byteLimited.stats.truncated).toBe(true);
    expect(innerDocument?.stats.truncated).toBe(true);
    expect(innerDocument?.children.map(({ name, status }) => [name, status])).toEqual([
      ['leaf.txt', 'failed'],
    ]);

    const entryLimited = await extract(outer, { limits: { zipEntries: 1 } });
    expect(entryLimited.stats.truncated).toBe(true);
    expect(entryLimited.children[0]?.document?.stats.truncated).toBe(true);
    expect(entryLimited.children[0]?.document?.children).toEqual([]);
  });

  it('lists an over-depth descendant without opening its payload', async () => {
    const inner = makeZip([{ name: 'leaf.txt', data: bytes('too deep') }]);
    const outer = makeZip([{ name: 'inner.zip', data: inner }]);

    const document = await extractor()(outer, { limits: { childDepth: 1 } });
    const nestedDocument = document.children[0]?.document;

    expect(
      nestedDocument?.children.map(({ path, status, document: child }) => [path, status, child]),
    ).toEqual([['inner.zip/leaf.txt', 'listed', undefined]]);
    expect(document.warnings.some(({ code }) => code === 'DEPTH_LIMIT')).toBe(true);
  });

  it('keeps child bytes opt-in for extracted nested contents', async () => {
    const leaf = bytes('raw child bytes');
    const inner = makeZip([{ name: 'leaf.txt', data: leaf }]);
    const outer = makeZip([{ name: 'inner.zip', data: inner }]);

    const withoutBytes = await extractor()(outer);
    expect(withoutBytes.children[0]?.bytes).toBeUndefined();
    expect(withoutBytes.children[0]?.document?.children[0]?.bytes).toBeUndefined();

    const withBytes = await extractor()(outer, { childBytes: true });
    expect(withBytes.children[0]?.bytes).toEqual(inner);
    expect(withBytes.children[0]?.document?.children[0]?.bytes).toEqual(leaf);
  });

  it('does not inflate corrupt payloads in list mode but detects them on extraction', async () => {
    const good = makeZip([{ name: 'corrupt.txt', data: bytes('payload'), method: 8 }]);
    const corrupted = corruptFirstDeflatePayload(good);

    const listed = await extractor()(corrupted, { children: 'list' });
    expect(listed.children.map(({ name, status }) => [name, status])).toEqual([['corrupt.txt', 'listed']]);

    const extracted = await extractor()(corrupted);
    expect(extracted.children.map(({ name, status, error }) => [name, status, error?.code])).toEqual([
      ['corrupt.txt', 'failed', 'UNREADABLE_PART'],
    ]);
  });

  it('omits regular children in skip mode while retaining the ZIP container result', async () => {
    const archive = makeZip([
      { name: 'one.txt', data: bytes('one') },
      { name: 'folder/', data: new Uint8Array() },
    ]);

    const document = await extractor()(archive, { children: 'skip' });

    expect(document.format).toBe('zip');
    expect(document.children.map(({ name, status }) => [name, status])).toEqual([['folder/', 'skipped']]);
  });

  it('indexes the default 10,000 entries once and preserves list order', async () => {
    const entries: ZipFixtureEntry[] = Array.from({ length: DEFAULT_LIMITS.zipEntries }, (_, index) => ({
      name: `entry-${index}.txt`,
      data: new Uint8Array(),
    }));
    const document = await extractor()(makeZip(entries), { children: 'list' });

    expect(document.children).toHaveLength(DEFAULT_LIMITS.zipEntries);
    expect(document.children[0]?.path).toBe('entry-0.txt');
    expect(document.children.at(-1)?.path).toBe('entry-9999.txt');
    expect(document.stats.truncated).toBe(false);
  });

  it('throws the actual compression-ratio limit for a ZIP bomb payload', async () => {
    const bomb = makeZip([{ name: 'repeat.txt', data: new Uint8Array(16_384).fill(0x41), method: 8 }]);

    await expect(
      extractor()(bomb, {
        limits: { compressionRatioMinBytes: 100, compressionRatio: 2 },
      }),
    ).rejects.toMatchObject<Partial<LimitExceededError>>({
      code: 'LIMIT_EXCEEDED',
      limit: 'compressionRatio',
    });
  });

  it('prevents direct and ancestor-identical pipeline recursion without inventing a ZIP quine', async () => {
    const rootBytes = bytes('ancestor-root');
    const loopReader: Reader = {
      id: 'txt',
      mimeTypes: ['text/plain'],
      async read(ctx) {
        const text = decoder.decode(ctx.bytes);
        ctx.out.paragraph(text);
        if (text === 'direct-recursion') await ctx.extractChild('same.txt', ctx.bytes);
        if (text === 'ancestor-root') await ctx.extractChild('middle.txt', bytes('middle-document'));
        if (text === 'middle-document') await ctx.extractChild('ancestor.txt', rootBytes);
      },
    };
    const extract = extractor(loopReader);

    const direct = await extract(bytes('direct-recursion'));
    expect(direct.children.map(({ name, status }) => [name, status])).toEqual([['same.txt', 'listed']]);
    expect(direct.warnings.some(({ code }) => code === 'DEPTH_LIMIT')).toBe(true);

    const ancestor = await extract(rootBytes);
    const middle = ancestor.children[0]?.document;
    expect(middle?.children.map(({ path, status }) => [path, status])).toEqual([
      ['middle.txt/ancestor.txt', 'listed'],
    ]);
    expect(ancestor.warnings.some(({ code }) => code === 'DEPTH_LIMIT')).toBe(true);
  });
});

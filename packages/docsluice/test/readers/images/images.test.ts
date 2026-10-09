import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AbortError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { DEFAULT_LIMITS, resolveLimits } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { ReadContext, Reader } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { imageReaders } from '../../../src/readers/images/index.js';
import { fuzzImage } from '../../../fuzz/images.fuzz.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../../corpus/images/${name}`, import.meta.url)));

type ImageTestOptions = ResolvedOptions & { imageGps?: boolean };

function context(
  reader: Reader,
  bytes: Uint8Array,
  options: { metadata?: boolean; imageGps?: boolean; signal?: AbortSignal } = {},
) {
  const warnings = new WarningSink();
  const budget = new Budget(DEFAULT_LIMITS, {
    warnings,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const resolved: ImageTestOptions = {
    limits: resolveLimits(),
    onLimit: 'throw',
    strict: false,
    metadata: options.metadata ?? true,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.imageGps !== undefined ? { imageGps: options.imageGps } : {}),
  };
  const out = new DocBuilder(reader.id, reader.mimeTypes[0] ?? 'application/octet-stream', budget, resolved);
  const ctx: ReadContext = {
    bytes,
    options: resolved,
    budget,
    warnings,
    out,
    path: 'sample.bin',
    extractChild: () => Promise.resolve(),
  };
  return { ctx, finish: () => out.finish() };
}

const byId = new Map(imageReaders.map((reader) => [reader.id, reader]));

async function extract(id: string, name: string, options: { metadata?: boolean; imageGps?: boolean } = {}) {
  const reader = byId.get(id);
  if (!reader) throw new Error(`Missing test reader: ${id}`);
  const target = context(reader, fixture(name), options);
  await reader.read(target.ctx);
  return target.finish();
}

async function extractBytes(
  id: string,
  bytes: Uint8Array,
  options: { metadata?: boolean; imageGps?: boolean; signal?: AbortSignal } = {},
) {
  const reader = byId.get(id);
  if (!reader) throw new Error(`Missing test reader: ${id}`);
  const target = context(reader, bytes, options);
  await reader.read(target.ctx);
  return target.finish();
}

function locateTiffTag(bytes: Uint8Array, ifd: number, tag: number, little: boolean): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(ifd, little);
  for (let index = 0; index < count; index += 1) {
    const offset = ifd + 2 + index * 12;
    if (view.getUint16(offset, little) === tag) return offset;
  }
  return undefined;
}

describe('image readers', () => {
  it.each([
    ['png', 'tiny.png'],
    ['gif', 'tiny.gif'],
    ['jpeg', 'jpeg-exif-structure.jpg'],
    ['tiff', 'tiff-le-metadata.tif'],
    ['tiff', 'tiff-be-metadata.tif'],
    ['webp', 'webp-vp8x-exif-snippet.webp'],
  ])('detects the %s signature without accepting an empty or damaged prefix', (id, name) => {
    const reader = byId.get(id)!;
    const bytes = fixture(name);
    expect(reader.detect?.(bytes)).toBe(1);
    expect(reader.detect?.(new Uint8Array())).toBe(0);
    const damaged = bytes.slice();
    damaged[0] = 0;
    expect(reader.detect?.(damaged)).toBe(0);
  });

  it.each([
    ['png', 'tiny.png', 1, 1],
    ['gif', 'tiny.gif', 1, 1],
    ['jpeg', 'jpeg-exif-structure.jpg', 5, 3],
    ['tiff', 'tiff-le-metadata.tif', 3, 2],
    ['tiff', 'tiff-be-metadata.tif', 3, 2],
    ['webp', 'webp-vp8-snippet.webp', 5, 3],
    ['webp', 'webp-vp8l-snippet.webp', 5, 3],
    ['webp', 'webp-vp8x-exif-snippet.webp', 5, 3],
  ])('reports dimensions without text for %s/%s', async (id, name, width, height) => {
    const doc = await extract(id, name);
    expect(doc.blocks).toEqual([
      { kind: 'image', mimeType: byId.get(id)!.mimeTypes[0], width, height, loc: { path: 'sample.bin' } },
    ]);
    expect(doc.blocks.some((block) => block.kind === 'paragraph')).toBe(false);
    expect(doc.metadata.custom).toContainEqual({ name: 'image.width', value: String(width) });
    expect(doc.metadata.custom).toContainEqual({ name: 'image.height', value: String(height) });
  });

  it('normalizes DateTimeOriginal and exposes synthetic Make, Model, and Orientation', async () => {
    const doc = await extract('tiff', 'tiff-le-metadata.tif');
    expect(doc.metadata.created).toBe('2019-04-05T12:34:56');
    expect(doc.metadata.custom).toEqual([
      { name: 'image.width', value: '3' },
      { name: 'image.height', value: '2' },
      { name: 'image.orientation', value: '6' },
      { name: 'image.make', value: 'SyntheticCo' },
      { name: 'image.model', value: 'Unit Camera' },
    ]);
  });

  it.each([
    ['jpeg', 'jpeg-exif-structure.jpg'],
    ['tiff', 'tiff-le-metadata.tif'],
    ['webp', 'webp-vp8x-exif-snippet.webp'],
  ])('reads DateTimeOriginal from %s metadata', async (id, name) => {
    const doc = await extract(id, name);
    expect(doc.metadata.created).toBe('2019-04-05T12:34:56');
  });

  it('rejects impossible capture dates instead of normalizing them', async () => {
    const bytes = fixture('tiff-le-metadata.tif');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const primary = view.getUint32(4, true);
    const exif = view.getUint32(locateTiffTag(bytes, primary, 34665, true)! + 8, true);
    const date = locateTiffTag(bytes, exif, 36867, true)!;
    const dateOffset = view.getUint32(date + 8, true);
    bytes.set(new TextEncoder().encode('2019:02:31 12:34:56\0'), dateOffset);
    const doc = await extractBytes('tiff', bytes);
    expect(doc.metadata.created).toBeUndefined();
  });

  it('keeps GPS out by default and includes coordinates only with imageGps enabled', async () => {
    const hidden = await extract('tiff', 'tiff-le-metadata.tif');
    expect(hidden.metadata.custom?.some(({ name }) => name.startsWith('image.gps.'))).toBe(false);
    const shown = await extract('tiff', 'tiff-le-metadata.tif', { imageGps: true });
    expect(shown.metadata.custom).toContainEqual({ name: 'image.gps.latitude', value: 'N 1° 2′ 3″' });
    expect(shown.metadata.custom).toContainEqual({ name: 'image.gps.longitude', value: 'W 4° 5′ 6″' });
    const bigEndian = await extract('tiff', 'tiff-be-metadata.tif', { imageGps: true });
    expect(bigEndian.metadata.custom).toContainEqual({ name: 'image.gps.latitude', value: 'N 1° 2′ 3″' });
  });

  it('reads finite GPS rationals only when all denominators are nonzero', async () => {
    const bytes = fixture('tiff-le-metadata.tif');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const primaryOffset = view.getUint32(4, true);
    const gpsPointerEntry = locateTiffTag(bytes, primaryOffset, 34853, true)!;
    const gpsOffset = view.getUint32(gpsPointerEntry + 8, true);
    const latitudeEntry = locateTiffTag(bytes, gpsOffset, 2, true)!;
    const latitudeOffset = view.getUint32(latitudeEntry + 8, true);
    view.setUint32(latitudeOffset + 4, 0, true);
    const doc = await extractBytes('tiff', bytes, { imageGps: true });
    expect(doc.metadata.custom?.some(({ name }) => name === 'image.gps.latitude')).toBe(false);
    expect(doc.metadata.custom).toContainEqual({ name: 'image.gps.longitude', value: 'W 4° 5′ 6″' });
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('metadata false suppresses every EXIF-derived field but preserves image dimensions', async () => {
    for (const [id, name, width, height] of [
      ['jpeg', 'jpeg-exif-structure.jpg', 5, 3],
      ['tiff', 'tiff-le-metadata.tif', 3, 2],
      ['webp', 'webp-vp8x-exif-snippet.webp', 5, 3],
    ] as const) {
      const doc = await extract(id, name, { metadata: false, imageGps: true });
      expect(doc.metadata).toEqual({});
      expect(doc.blocks).toContainEqual(expect.objectContaining({ kind: 'image', width, height }));
    }
  });

  it.each([
    'hostile/tiff-cyclic-ifd.tif',
    'hostile/tiff-huge-count.tif',
    'hostile/tiff-truncated-value-offset.tif',
  ])('survives hostile TIFF structure %s without leaking bytes in warnings', async (name) => {
    const doc = await extract('tiff', name);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]).toMatchObject({ kind: 'image', mimeType: 'image/tiff' });
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(doc.warnings.every(({ message }) => !message.includes('Synthetic'))).toBe(true);
  });

  it('bounds truncated and impossible chunk/marker offsets', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x45]);
    const jpegResult = context(byId.get('jpeg')!, jpeg);
    await byId.get('jpeg')!.read(jpegResult.ctx);
    expect(jpegResult.finish().warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');

    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0xff, 0xff, 0xff, 0x57, 0x45, 0x42, 0x50]);
    const webpResult = context(byId.get('webp')!, webp);
    await byId.get('webp')!.read(webpResult.ctx);
    expect(webpResult.finish().warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('handles TIFF unknown field types and truncated external values', async () => {
    const bytes = fixture('tiff-le-metadata.tif');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ifd = view.getUint32(4, true);
    const width = locateTiffTag(bytes, ifd, 256, true)!;
    view.setUint16(width + 2, 12, true);
    const unknownType = await extractBytes('tiff', bytes);
    expect(unknownType.blocks[0]).toMatchObject({ kind: 'image', mimeType: 'image/tiff' });
    expect(unknownType.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');

    const truncated = fixture('tiff-le-metadata.tif');
    const truncatedView = new DataView(truncated.buffer, truncated.byteOffset, truncated.byteLength);
    const truncatedIfd = truncatedView.getUint32(4, true);
    const model = locateTiffTag(truncated, truncatedIfd, 272, true)!;
    truncatedView.setUint32(model + 8, truncated.length - 1, true);
    const truncatedDoc = await extractBytes('tiff', truncated);
    expect(truncatedDoc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('uses typed-array byteOffset correctly', async () => {
    const original = fixture('tiff-be-metadata.tif');
    const wrapped = new Uint8Array(original.length + 9);
    wrapped.set(original, 4);
    const view = wrapped.subarray(4, 4 + original.length);
    const doc = await extractBytes('tiff', view);
    expect(doc.blocks[0]).toMatchObject({ kind: 'image', width: 3, height: 2 });
    expect(doc.metadata.created).toBe('2019-04-05T12:34:56');
  });

  it('uses IFD0 dimensions even when later TIFF directories differ', async () => {
    const original = fixture('tiff-le-metadata.tif');
    const first = new DataView(original.buffer, original.byteOffset, original.byteLength);
    const ifd0 = first.getUint32(4, true);
    const entryCount = first.getUint16(ifd0, true);
    const nextPointer = ifd0 + 2 + entryCount * 12;
    const secondOffset = original.length;
    const bytes = new Uint8Array(original.length + 30);
    bytes.set(original);
    const view = new DataView(bytes.buffer);
    view.setUint32(nextPointer, secondOffset, true);
    view.setUint16(secondOffset, 2, true);
    view.setUint16(secondOffset + 2, 256, true);
    view.setUint16(secondOffset + 4, 4, true);
    view.setUint32(secondOffset + 6, 1, true);
    view.setUint32(secondOffset + 10, 9, true);
    view.setUint16(secondOffset + 14, 257, true);
    view.setUint16(secondOffset + 16, 4, true);
    view.setUint32(secondOffset + 18, 1, true);
    view.setUint32(secondOffset + 22, 8, true);
    view.setUint32(secondOffset + 26, 0, true);
    const doc = await extractBytes('tiff', bytes);
    expect(doc.blocks[0]).toMatchObject({ kind: 'image', width: 3, height: 2 });
  });

  it('uses the VP8X canvas dimensions for extended WebP', async () => {
    const bytes = fixture('webp-vp8x-exif-snippet.webp');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(39, 6 | (3 << 14), true);
    const doc = await extractBytes('webp', bytes);
    expect(doc.blocks[0]).toMatchObject({ kind: 'image', width: 5, height: 3 });
  });

  it('honors the extraction abort signal before scanning input', async () => {
    const controller = new AbortController();
    controller.abort();
    const reader = byId.get('jpeg')!;
    const target = context(reader, fixture('jpeg-exif-structure.jpg'), { signal: controller.signal });
    await expect(reader.read(target.ctx)).rejects.toBeInstanceOf(AbortError);
  });

  it('fuzzes arbitrary signatures without throwing or building text', async () => {
    await expect(fuzzImage(new Uint8Array(0))).resolves.toBeUndefined();
    await expect(
      fuzzImage(Uint8Array.from({ length: 128 }, (_, index) => index & 0xff)),
    ).resolves.toBeUndefined();
    await expect(fuzzImage(fixture('hostile/tiff-huge-count.tif'))).resolves.toBeUndefined();
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createExtractor } from '../../../src/core/extract.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import type { ExtractOptions } from '../../../src/core/options.js';
import { detect } from '../../../src/detect/detect.js';
import { imageReaders } from '../../../src/readers/images/index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../../../corpus/images/${name}`, import.meta.url)));

const registry = new ReaderRegistry();
for (const reader of imageReaders) {
  registry.add({ id: reader.id, mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
}
const extractRegistered = createExtractor(registry);

type ImageOptions = ExtractOptions & { imageGps?: boolean };
const imageOptions = (options: ImageOptions = {}) => options as ExtractOptions;

describe('image pipeline dispatch regression (standalone integration evidence)', () => {
  it.each([
    ['tiny.png', 'png'],
    ['jpeg-exif-structure.jpg', 'jpeg'],
    ['tiny.gif', 'gif'],
    ['tiff-le-metadata.tif', 'tiff'],
    ['tiff-be-metadata.tif', 'tiff'],
    ['webp-vp8-snippet.webp', 'webp'],
    ['webp-vp8l-snippet.webp', 'webp'],
    ['webp-vp8x-exif-snippet.webp', 'webp'],
  ])('detects %s as %s through the public detector', async (name, format) => {
    expect((await detect(fixture(name))).format).toBe(format);
  });

  it.each([
    ['tiny.png', 'png', 'image/png', 1, 1],
    ['jpeg-exif-structure.jpg', 'jpeg', 'image/jpeg', 5, 3],
    ['tiny.gif', 'gif', 'image/gif', 1, 1],
    ['tiff-le-metadata.tif', 'tiff', 'image/tiff', 3, 2],
    ['tiff-be-metadata.tif', 'tiff', 'image/tiff', 3, 2],
    ['webp-vp8-snippet.webp', 'webp', 'image/webp', 5, 3],
    ['webp-vp8l-snippet.webp', 'webp', 'image/webp', 5, 3],
    ['webp-vp8x-exif-snippet.webp', 'webp', 'image/webp', 5, 3],
  ])('dispatches registered reader for %s', async (name, format, mimeType, width, height) => {
    const doc = await extractRegistered(fixture(name));
    expect(doc.format).toBe(format);
    expect(doc.mimeType).toBe(mimeType);
    expect(doc.blocks).toContainEqual(expect.objectContaining({ kind: 'image', width, height }));
    expect(doc.blocks.some((block) => block.kind === 'paragraph')).toBe(false);
  });

  it('routes metadata and GPS privacy options through extract()', async () => {
    const bytes = fixture('tiff-le-metadata.tif');
    const normal = await extractRegistered(bytes);
    expect(normal.metadata.created).toBe('2019-04-05T12:34:56');
    expect(normal.metadata.custom?.some(({ name }) => name.startsWith('image.gps.'))).toBe(false);

    const withGps = await extractRegistered(bytes, imageOptions({ imageGps: true }));
    expect(withGps.metadata.custom).toContainEqual({ name: 'image.gps.latitude', value: 'N 1° 2′ 3″' });
    expect(withGps.metadata.custom).toContainEqual({ name: 'image.gps.longitude', value: 'W 4° 5′ 6″' });

    const metadataOff = await extractRegistered(bytes, imageOptions({ metadata: false, imageGps: true }));
    expect(metadataOff.metadata).toEqual({});
    expect(metadataOff.blocks).toContainEqual(
      expect.objectContaining({ kind: 'image', width: 3, height: 2 }),
    );
  });

  it('retains the empty fallback when no reader is registered for a no-text format', async () => {
    const empty = createExtractor(new ReaderRegistry());
    const doc = await empty(fixture('tiny.png'));
    expect(doc.format).toBe('png');
    expect(doc.blocks).toEqual([]);
  });
});

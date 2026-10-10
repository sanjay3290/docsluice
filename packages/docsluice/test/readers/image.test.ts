import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { exifDate, readTiff } from '../../src/readers/image/exif.js';
import { imageFormat, imageInfo } from '../../src/readers/image/index.js';
import { fuzzImage } from '../../fuzz/image.fuzz.js';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../corpus/image/${name}`, import.meta.url)));
const budget = () => new Budget(DEFAULT_LIMITS);

describe('image reader', () => {
  it.each([
    ['gradient.png', 'png', 'image/png', 16, 9],
    ['gradient-exif.jpg', 'jpeg', 'image/jpeg', 32, 24],
    ['gradient.gif', 'gif', 'image/gif', 12, 8],
    ['gradient-lossy.webp', 'webp', 'image/webp', 40, 30],
    ['gradient-lossless-exif.webp', 'webp', 'image/webp', 24, 16],
    ['gradient-le.tif', 'tiff', 'image/tiff', 10, 6],
    ['gradient-be.tif', 'tiff', 'image/tiff', 7, 5],
  ])('%s gives one image block with its size and no text', async (name, format, mimeType, width, height) => {
    const doc = await extract(corpus(name));
    expect(doc.format).toBe(format);
    expect(doc.blocks).toEqual([{ kind: 'image', mimeType, width, height, loc: { offset: [0, 0] } }]);
    expect(doc.warnings).toEqual([]);
  });

  it('reads EXIF date, orientation and camera, and GPS only with imageGps', async () => {
    const plain = await extract(corpus('gradient-exif.jpg'));
    expect(plain.metadata).toEqual({
      created: '2026-05-14T08:30:00+02:00',
      custom: [
        { name: 'orientation', value: '6' },
        { name: 'cameraMake', value: 'Docsluice Optics' },
        { name: 'cameraModel', value: 'Fixture 1' },
      ],
    });
    const gps = await extract(corpus('gradient-exif.jpg'), { imageGps: true });
    expect(gps.metadata.custom?.slice(3)).toEqual([
      { name: 'gpsLatitude', value: '-0.505' },
      { name: 'gpsLongitude', value: '-1.25' },
      { name: 'gpsAltitude', value: '12.5' },
    ]);
  });

  it('drops all EXIF with metadata: false, even with imageGps', async () => {
    const doc = await extract(corpus('gradient-exif.jpg'), { metadata: false, imageGps: true });
    expect(doc.metadata).toEqual({});
    expect(doc.blocks).toMatchObject([{ kind: 'image', width: 32, height: 24 }]);
  });

  it('reads EXIF from PNG eXIf, WebP EXIF and TIFF IFD0, in either byte order', async () => {
    expect((await extract(corpus('gradient-exif.png'))).metadata.created).toBe('2025-12-31T23:59:59');
    expect((await extract(corpus('gradient-lossless-exif.webp'))).metadata.created).toBe(
      '2026-01-02T03:04:05-05:00',
    );
    expect((await extract(corpus('gradient-le.tif'))).metadata.created).toBe('2026-03-04T05:06:07');
    expect((await extract(corpus('gradient-be.tif'))).metadata).toEqual({
      created: '2024-02-29T12:00:00',
      custom: [{ name: 'orientation', value: '3' }],
    });
  });

  it('keeps the size of an image inside a container', async () => {
    const doc = await extract(corpus('gradient.png'), { filename: 'x.png' });
    expect(doc.blocks[0]).toMatchObject({ width: 16, height: 9 });
  });
});

describe('image headers and EXIF', () => {
  it('names formats by signature', () => {
    expect(imageFormat(corpus('gradient.gif'))).toBe('gif');
    expect(imageFormat(Uint8Array.of(1, 2, 3))).toBeUndefined();
    expect(imageInfo(undefined, Uint8Array.of(1), budget()).info.damaged).toBe(true);
  });

  it('parses EXIF dates and rejects malformed ones', () => {
    expect(exifDate('2026:05:14 08:30:00', '+02:00')).toBe('2026-05-14T08:30:00+02:00');
    expect(exifDate('2026:05:14 08:30:00', 'bad')).toBe('2026-05-14T08:30:00');
    expect(exifDate('0000:00:00 00:00:00', undefined)).toBeUndefined();
    expect(exifDate('2026-05-14', undefined)).toBeUndefined();
    expect(exifDate('2026:0x:14 08:30:00', undefined)).toBeUndefined();
  });

  it('marks IFD loops and out-of-range values as damage without looping', () => {
    const le16 = (value: number) => [value & 0xff, value >> 8];
    const le32 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24];
    const entry = (tag: number, type: number, count: number, value: number) => [
      ...le16(tag),
      ...le16(type),
      ...le32(count),
      ...le32(value),
    ];
    const loop = Uint8Array.from([
      0x49,
      0x49,
      ...le16(42),
      ...le32(8),
      ...le16(1),
      ...entry(256, 3, 1, 5),
      ...le32(8),
    ]);
    expect(readTiff(loop, budget())).toMatchObject({ width: 5, damaged: true });
    expect(readTiff(Uint8Array.of(0x4d, 0x4d, 0, 43, 0, 0, 0, 8), budget())).toBeUndefined();
    expect(readTiff(Uint8Array.of(0x49, 0x49), budget())).toBeUndefined();
  });

  it('survives the fuzz target on corpus files and truncations', () => {
    for (const name of [
      'gradient-exif.jpg',
      'gradient-lossless-exif.webp',
      'gradient-be.tif',
      'gradient-exif.png',
    ]) {
      const bytes = corpus(name);
      for (const end of [bytes.length, bytes.length >> 1, 12])
        expect(() => fuzzImage(bytes.subarray(0, end))).not.toThrow();
    }
  });
});

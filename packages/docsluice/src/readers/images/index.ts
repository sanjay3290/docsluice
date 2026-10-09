import type { ImageBlock, FormatId } from '../../core/model.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { hasAscii, isExifPayload, parseExifTiff, type ExifData } from './exif.js';

interface ImageInfo {
  width?: number;
  height?: number;
  exif?: ExifData;
  malformed: boolean;
}

interface ImageOptions {
  imageGps?: boolean;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const JPEG_MIME = 'image/jpeg';
const TIFF_MIME = 'image/tiff';

function range(bytes: Uint8Array, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= bytes.length &&
    length <= bytes.length - offset
  );
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  return hasAscii(bytes, offset, value);
}

function u16(view: DataView, offset: number, little: boolean): number | undefined {
  return range(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset, 2)
    ? view.getUint16(offset, little)
    : undefined;
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32(view: DataView, offset: number, little: boolean): number | undefined {
  return range(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset, 4)
    ? view.getUint32(offset, little)
    : undefined;
}

function parsePng(bytes: Uint8Array, ctx: ReadContext): ImageInfo {
  if (!range(bytes, 0, 33) || !PNG_SIGNATURE.every((value, index) => bytes[index] === value))
    return { malformed: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = u32(view, 8, false);
  if (length !== 13 || !ascii(bytes, 12, 'IHDR')) return { malformed: true };
  ctx.budget.tick();
  const width = u32(view, 16, false);
  const height = u32(view, 20, false);
  if (!width || !height) return { malformed: true };
  return { width, height, malformed: false };
}

function isJpegSof(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function parseJpeg(bytes: Uint8Array, ctx: ReadContext, includeExif: boolean): ImageInfo {
  if (!range(bytes, 0, 3) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return { malformed: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result: ImageInfo = { malformed: false };
  let offset = 2;
  while (offset < bytes.length) {
    ctx.budget.tick();
    if (bytes[offset] !== 0xff) {
      result.malformed = true;
      break;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      ctx.budget.tick();
      offset += 1;
    }
    if (offset >= bytes.length) {
      result.malformed = true;
      break;
    }
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = u16(view, offset, false);
    if (segmentLength === undefined || segmentLength < 2 || !range(bytes, offset, segmentLength)) {
      result.malformed = true;
      break;
    }
    const payload = offset + 2;
    const payloadLength = segmentLength - 2;
    if (isJpegSof(marker) && payloadLength >= 5) {
      const height = u16(view, payload + 1, false);
      const width = u16(view, payload + 3, false);
      if (width && height) {
        result.width = width;
        result.height = height;
      } else result.malformed = true;
    } else if (includeExif && marker === 0xe1 && isExifPayload(bytes, payload, payloadLength)) {
      const exifBytes = bytes.subarray(payload + 6, payload + payloadLength);
      result.exif = parseExifTiff(exifBytes, ctx, true);
      result.malformed ||= result.exif.malformed;
    }
    offset += segmentLength;
  }
  if (result.width === undefined || result.height === undefined) result.malformed = true;
  return result;
}

function parseGif(bytes: Uint8Array): ImageInfo {
  if (!range(bytes, 0, 10) || !(ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')))
    return { malformed: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = u16(view, 6, true);
  const height = u16(view, 8, true);
  if (!width || !height) return { malformed: true };
  return { width, height, malformed: false };
}

function parseTiff(bytes: Uint8Array, ctx: ReadContext, includeExif: boolean): ImageInfo {
  const exif = parseExifTiff(bytes, ctx, includeExif);
  return {
    ...(exif.width !== undefined ? { width: exif.width } : {}),
    ...(exif.height !== undefined ? { height: exif.height } : {}),
    exif,
    malformed: exif.malformed,
  };
}

function parseWebp(bytes: Uint8Array, ctx: ReadContext, includeExif: boolean): ImageInfo {
  if (!range(bytes, 0, 12) || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP'))
    return { malformed: true };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riffLength = u32(view, 4, true);
  if (riffLength === undefined || riffLength < 4) return { malformed: true };
  const end = riffLength + 8;
  const result: ImageInfo = { malformed: end > bytes.length };
  const limit = Math.min(end, bytes.length);
  let offset = 12;
  let hasCanvasDimensions = false;
  while (offset < limit) {
    ctx.budget.tick();
    if (!range(bytes, offset, 8) || offset + 8 > limit) {
      result.malformed = true;
      break;
    }
    const chunkLength = u32(view, offset + 4, true);
    if (
      chunkLength === undefined ||
      !range(bytes, offset + 8, chunkLength) ||
      offset + 8 + chunkLength > limit
    ) {
      result.malformed = true;
      break;
    }
    const payload = offset + 8;
    const chunk = bytes.subarray(offset, offset + 4);
    if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x58) {
      if (chunkLength < 10) result.malformed = true;
      else {
        result.width = u24le(bytes, payload + 4) + 1;
        result.height = u24le(bytes, payload + 7) + 1;
        hasCanvasDimensions = true;
      }
    } else if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x20) {
      if (chunkLength < 10 || !ascii(bytes, payload + 3, '\x9d\x01\x2a')) result.malformed = true;
      else if (!hasCanvasDimensions) {
        result.width = u16(view, payload + 6, true)! & 0x3fff;
        result.height = u16(view, payload + 8, true)! & 0x3fff;
      }
    } else if (chunk[0] === 0x56 && chunk[1] === 0x50 && chunk[2] === 0x38 && chunk[3] === 0x4c) {
      if (chunkLength < 5 || bytes[payload] !== 0x2f) result.malformed = true;
      else if (!hasCanvasDimensions) {
        const bits = u32(view, payload + 1, true)!;
        result.width = (bits & 0x3fff) + 1;
        result.height = ((bits >>> 14) & 0x3fff) + 1;
      }
    } else if (
      includeExif &&
      chunk[0] === 0x45 &&
      chunk[1] === 0x58 &&
      chunk[2] === 0x49 &&
      chunk[3] === 0x46
    ) {
      const prefix = isExifPayload(bytes, payload, chunkLength) ? 6 : 0;
      if (chunkLength < prefix + 8) result.malformed = true;
      else {
        result.exif = parseExifTiff(bytes.subarray(payload + prefix, payload + chunkLength), ctx, true);
        result.malformed ||= result.exif.malformed;
      }
    }
    const paddedLength = chunkLength + (chunkLength & 1);
    if (!range(bytes, offset + 8, paddedLength) || offset + 8 + paddedLength > limit) {
      if (chunkLength & 1) result.malformed = true;
      offset += 8 + chunkLength;
    } else offset += 8 + paddedLength;
  }
  if (result.width === undefined || result.height === undefined) result.malformed = true;
  return result;
}

function metadataOptions(ctx: ReadContext): { metadata: boolean; imageGps: boolean } {
  const options = ctx.options as typeof ctx.options & ImageOptions;
  return { metadata: options.metadata !== false, imageGps: options.imageGps === true };
}

function emit(ctx: ReadContext, mimeType: string, info: ImageInfo): void {
  const { metadata, imageGps } = metadataOptions(ctx);
  const custom: Array<{ name: string; value: string }> = [];
  const exif = info.exif;
  if (metadata) {
    if (info.width !== undefined) custom.push({ name: 'image.width', value: String(info.width) });
    if (info.height !== undefined) custom.push({ name: 'image.height', value: String(info.height) });
  }
  if (metadata) {
    if (exif?.orientation !== undefined)
      custom.push({ name: 'image.orientation', value: String(exif.orientation) });
    if (exif?.make) custom.push({ name: 'image.make', value: exif.make });
    if (exif?.model) custom.push({ name: 'image.model', value: exif.model });
    if (imageGps && exif?.latitude) custom.push({ name: 'image.gps.latitude', value: exif.latitude });
    if (imageGps && exif?.longitude) custom.push({ name: 'image.gps.longitude', value: exif.longitude });
    if (exif?.created || custom.length > 0) {
      ctx.out.setMetadata({
        ...(exif?.created ? { created: exif.created } : {}),
        ...(custom.length ? { custom } : {}),
      });
    }
  }
  const image: Omit<ImageBlock, 'kind' | 'loc'> = { mimeType };
  if (info.width !== undefined) image.width = info.width;
  if (info.height !== undefined) image.height = info.height;
  ctx.out.image(image, ctx.path ? { path: ctx.path } : {});
  if (info.malformed) {
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'Image structure is incomplete or malformed.' });
  }
}

function createReader(id: FormatId, mimeType: string, signature: (bytes: Uint8Array) => boolean): Reader {
  return {
    id,
    mimeTypes: [mimeType],
    detect: (bytes) => (signature(bytes) ? 1 : 0),
    read(ctx) {
      return Promise.resolve().then(() => {
        ctx.budget.tick();
        const { metadata } = metadataOptions(ctx);
        let info: ImageInfo;
        switch (id) {
          case 'png':
            info = parsePng(ctx.bytes, ctx);
            break;
          case 'jpeg':
            info = parseJpeg(ctx.bytes, ctx, metadata);
            break;
          case 'gif':
            info = parseGif(ctx.bytes);
            break;
          case 'tiff':
            info = parseTiff(ctx.bytes, ctx, metadata);
            break;
          case 'webp':
            info = parseWebp(ctx.bytes, ctx, metadata);
            break;
          default:
            info = { malformed: true };
        }
        emit(ctx, mimeType, info);
      });
    },
  };
}

export const pngReader = createReader(
  'png',
  'image/png',
  (bytes) => range(bytes, 0, 8) && PNG_SIGNATURE.every((value, index) => bytes[index] === value),
);
export const jpegReader = createReader(
  'jpeg',
  JPEG_MIME,
  (bytes) => range(bytes, 0, 3) && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
);
export const gifReader = createReader(
  'gif',
  'image/gif',
  (bytes) => ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'),
);
export const tiffReader = createReader(
  'tiff',
  TIFF_MIME,
  (bytes) => ascii(bytes, 0, 'II\x2a\0') || ascii(bytes, 0, 'MM\0\x2a'),
);
export const webpReader = createReader(
  'webp',
  'image/webp',
  (bytes) => ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP'),
);

export const imageReaders: readonly Reader[] = [pngReader, jpegReader, gifReader, tiffReader, webpReader];

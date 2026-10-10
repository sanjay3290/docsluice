import type { Budget } from '../../core/budget.js';
import type { ReadContext, Reader } from '../../core/reader.js';
import { readTiff } from './exif.js';
import type { TiffInfo } from './exif.js';

/** What an image header gives: its size and, when it carries EXIF, the TIFF block. */
export interface ImageInfo {
  width?: number;
  height?: number;
  exif?: Uint8Array;
  damaged: boolean;
}

const MIME_TYPES = new Map([
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['tiff', 'image/tiff'],
  ['webp', 'image/webp'],
]);

const be32 = (data: Uint8Array, at: number) =>
  at + 4 <= data.length
    ? ((data[at]! << 24) | (data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!) >>> 0
    : undefined;
const be16 = (data: Uint8Array, at: number) =>
  at + 2 <= data.length ? (data[at]! << 8) | data[at + 1]! : undefined;
const le16 = (data: Uint8Array, at: number) =>
  at + 2 <= data.length ? data[at]! | (data[at + 1]! << 8) : undefined;
const le24 = (data: Uint8Array, at: number) =>
  at + 3 <= data.length ? data[at]! | (data[at + 1]! << 8) | (data[at + 2]! << 16) : undefined;
const le32 = (data: Uint8Array, at: number) =>
  at + 4 <= data.length ? (le16(data, at)! | (le16(data, at + 2)! << 16)) >>> 0 : undefined;
const tag = (data: Uint8Array, at: number) =>
  at + 4 <= data.length ? String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!) : '';

/** PNG (ISO/IEC 15948): `IHDR` gives the size; an `eXIf` chunk holds EXIF. Chunks are walked to `IEND`. */
function png(data: Uint8Array, budget: Budget): ImageInfo {
  const info: ImageInfo = {
    width: be32(data, 16),
    height: be32(data, 20),
    damaged: tag(data, 12) !== 'IHDR',
  };
  for (let at = 8; at + 8 <= data.length;) {
    budget.tick();
    const length = be32(data, at)!;
    const name = tag(data, at + 4);
    if (at + 12 + length > data.length) {
      info.damaged = true;
      break;
    }
    if (name === 'eXIf') info.exif = data.subarray(at + 8, at + 8 + length);
    if (name === 'IEND') break;
    at += 12 + length;
  }
  return info;
}

/** Start-of-frame markers that carry the image size (ITU T.81 B.1.1.3). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/** JPEG: segments up to the start of scan; `SOFn` gives the size, an `APP1` `Exif` block holds EXIF. */
function jpeg(data: Uint8Array, budget: Budget): ImageInfo {
  const info: ImageInfo = { damaged: false };
  let at = 2;
  while (at + 4 <= data.length) {
    budget.tick();
    if (data[at] !== 0xff) {
      info.damaged = true;
      break;
    }
    const marker = data[at + 1]!;
    if (marker === 0xff) {
      at++;
      continue;
    }
    // Markers without a length: TEM, RSTn, SOI.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = be16(data, at + 2)!;
    if (length < 2 || at + 2 + length > data.length) {
      info.damaged = true;
      break;
    }
    const body = data.subarray(at + 4, at + 2 + length);
    if (SOF.has(marker) && info.width === undefined) {
      info.height = be16(body, 1);
      info.width = be16(body, 3);
    } else if (
      marker === 0xe1 &&
      info.exif === undefined &&
      tag(body, 0) === 'Exif' &&
      body[4] === 0 &&
      body[5] === 0
    ) {
      info.exif = body.subarray(6);
    }
    at += 2 + length;
  }
  return info;
}

/** GIF: the logical screen size. */
function gif(data: Uint8Array): ImageInfo {
  return { width: le16(data, 6), height: le16(data, 8), damaged: data.length < 10 };
}

/** WebP (RFC 9649): `VP8 `, `VP8L` or `VP8X` give the size; an `EXIF` chunk holds EXIF. */
function webp(data: Uint8Array, budget: Budget): ImageInfo {
  const info: ImageInfo = { damaged: false };
  for (let at = 12; at + 8 <= data.length;) {
    budget.tick();
    const name = tag(data, at);
    const size = le32(data, at + 4)!;
    const body = at + 8;
    if (body + size > data.length) {
      info.damaged = true;
      break;
    }
    if (name === 'VP8X' && size >= 10) {
      info.width = le24(data, body + 4)! + 1;
      info.height = le24(data, body + 7)! + 1;
    } else if (name === 'VP8 ' && size >= 10 && info.width === undefined) {
      if (data[body + 3] === 0x9d && data[body + 4] === 0x01 && data[body + 5] === 0x2a) {
        info.width = le16(data, body + 6)! & 0x3fff;
        info.height = le16(data, body + 8)! & 0x3fff;
      } else info.damaged = true;
    } else if (name === 'VP8L' && size >= 5 && info.width === undefined) {
      if (data[body] === 0x2f) {
        const bits = le32(data, body + 1)!;
        info.width = (bits & 0x3fff) + 1;
        info.height = ((bits >>> 14) & 0x3fff) + 1;
      } else info.damaged = true;
    } else if (name === 'EXIF') {
      const exif = data.subarray(body, body + size);
      // Some writers keep the JPEG `Exif\0\0` prefix.
      info.exif = tag(exif, 0) === 'Exif' ? exif.subarray(6) : exif;
    }
    at = body + size + (size & 1);
  }
  return info;
}

/** The image format from its signature (the same magic numbers detection uses), else `undefined`. */
export function imageFormat(data: Uint8Array): string | undefined {
  if (be32(data, 0) === 0x89504e47) return 'png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (tag(data, 0) === 'GIF8') return 'gif';
  if (tag(data, 0) === 'RIFF' && tag(data, 8) === 'WEBP') return 'webp';
  const order = tag(data, 0);
  if (order === 'II*\0' || order === 'MM\0*') return 'tiff';
  return undefined;
}

/** The size and EXIF block of an image in one of the detected formats. */
export function imageInfo(
  format: string | undefined,
  data: Uint8Array,
  budget: Budget,
): { info: ImageInfo; tiff?: TiffInfo } {
  let info: ImageInfo;
  let tiff: TiffInfo | undefined;
  if (format === 'tiff') {
    tiff = readTiff(data, budget);
    info = { width: tiff?.width, height: tiff?.height, damaged: tiff === undefined || tiff.damaged };
  } else {
    info =
      format === 'png'
        ? png(data, budget)
        : format === 'jpeg'
          ? jpeg(data, budget)
          : format === 'gif'
            ? gif(data)
            : format === 'webp'
              ? webp(data, budget)
              : { damaged: true };
    if (info.exif) tiff = readTiff(info.exif, budget);
  }
  return tiff ? { info, tiff } : { info };
}

/**
 * Image reader for PNG, JPEG, GIF, TIFF and WebP: no text, one `image` block with the pixel size,
 * and EXIF metadata. The capture date (`DateTimeOriginal`, else `DateTime`) is `metadata.created`;
 * orientation, camera make and model are custom properties; GPS position only with `imageGps: true`.
 * `metadata: false` drops all EXIF. Headers and IFDs are walked with bounds checks and visited sets.
 */
export const imageReader: Reader = {
  id: 'image',
  mimeTypes: [...MIME_TYPES.values()],
  async read(ctx: ReadContext): Promise<void> {
    await Promise.resolve();
    ctx.budget.tick();
    const format = imageFormat(ctx.bytes);
    const { info, tiff } = imageInfo(format, ctx.bytes, ctx.budget);
    const image: { mimeType?: string; width?: number; height?: number } = {};
    const mimeType = format === undefined ? undefined : MIME_TYPES.get(format);
    if (mimeType) image.mimeType = mimeType;
    if (info.width !== undefined && info.height !== undefined && info.width > 0 && info.height > 0) {
      image.width = info.width;
      image.height = info.height;
    }
    ctx.out.image(image, ctx.path ? { path: ctx.path } : {});
    if (info.damaged || tiff?.damaged)
      ctx.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'The image header or its EXIF data is damaged; what could be read is kept.',
        ...(ctx.path ? { loc: { path: ctx.path } } : {}),
      });
    if (!tiff || !ctx.options.metadata) return;
    if (tiff.taken) ctx.out.setMetadata({ created: tiff.taken });
    const custom: Array<{ name: string; value: string }> = [];
    if (tiff.orientation !== undefined) custom.push({ name: 'orientation', value: String(tiff.orientation) });
    if (tiff.make) custom.push({ name: 'cameraMake', value: tiff.make });
    if (tiff.model) custom.push({ name: 'cameraModel', value: tiff.model });
    if (ctx.options.imageGps === true) {
      if (tiff.latitude !== undefined) custom.push({ name: 'gpsLatitude', value: String(tiff.latitude) });
      if (tiff.longitude !== undefined) custom.push({ name: 'gpsLongitude', value: String(tiff.longitude) });
      if (tiff.altitude !== undefined) custom.push({ name: 'gpsAltitude', value: String(tiff.altitude) });
    }
    if (custom.length > 0) ctx.out.setMetadata({ custom });
  },
};

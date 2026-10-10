import type { FormatId } from '../core/model.js';

export interface MagicSniffResult {
  kind: FormatId | 'exe' | null;
  mimeType: string | null;
  confidence: number;
}

const MAX_SNIFF_BYTES = 4096;
const PDF_SCAN_BYTES = 1024;
const NONE = Object.freeze<MagicSniffResult>({ kind: null, mimeType: null, confidence: 0 });
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04] as const;
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06] as const;
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08] as const;
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const TIFF_LE = [0x49, 0x49, 0x2a, 0x00] as const;
const TIFF_BE = [0x4d, 0x4d, 0x00, 0x2a] as const;
const SEVEN_ZIP = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] as const;
const RAR = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] as const;
const ICO = [0x00, 0x00, 0x01, 0x00] as const;
const PE = [0x4d, 0x5a] as const;
const ELF = [0x7f, 0x45, 0x4c, 0x46] as const;
const MACHO_BE_32 = [0xfe, 0xed, 0xfa, 0xce] as const;
const MACHO_LE_32 = [0xce, 0xfa, 0xed, 0xfe] as const;
const MACHO_BE_64 = [0xfe, 0xed, 0xfa, 0xcf] as const;
const MACHO_LE_64 = [0xcf, 0xfa, 0xed, 0xfe] as const;
const MACHO_FAT = [0xca, 0xfe, 0xba, 0xbe] as const;
const MACHO_FAT_SWAPPED = [0xbe, 0xba, 0xfe, 0xca] as const;
const MACHO_FAT_64 = [0xca, 0xfe, 0xba, 0xbf] as const;
const MACHO_FAT_64_SWAPPED = [0xbf, 0xba, 0xfe, 0xca] as const;

function result(kind: FormatId | 'exe', mimeType: string, confidence = 1): MagicSniffResult {
  return { kind, mimeType, confidence };
}

function matches(bytes: Uint8Array, offset: number, signature: readonly number[]): boolean {
  if (offset + signature.length > bytes.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

/** Identify a container or binary format from at most its first 4 KB. */
export function sniffMagic(input: Uint8Array): MagicSniffResult {
  const bytes = input;
  const length = Math.min(input.length, MAX_SNIFF_BYTES);

  if (matches(bytes, 0, ZIP_LOCAL) || matches(bytes, 0, ZIP_EMPTY) || matches(bytes, 0, ZIP_SPANNED)) {
    return result('zip', 'application/zip');
  }
  if (matches(bytes, 0, OLE)) {
    return result('ole', 'application/x-ole-storage');
  }
  if (ascii(bytes, 0, '{\\rtf')) return result('rtf', 'application/rtf');
  if (matches(bytes, 0, [0x1f, 0x8b])) return result('gzip', 'application/gzip');
  if (length >= 262 && ascii(bytes, 257, 'ustar')) return result('tar', 'application/x-tar');
  // Detection only: 7z and RAR are read by the opt-in plugins `docsluice/7z` and `docsluice/rar`.
  if (matches(bytes, 0, SEVEN_ZIP)) return result('7z', 'application/x-7z-compressed');
  if (matches(bytes, 0, RAR) && (bytes[6] === 0x00 || (bytes[6] === 0x01 && bytes[7] === 0x00)))
    return result('rar', 'application/vnd.rar');

  if (matches(bytes, 0, PNG)) {
    return result('png', 'image/png');
  }
  if (matches(bytes, 0, [0xff, 0xd8, 0xff])) return result('jpeg', 'image/jpeg');
  if (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a')) return result('gif', 'image/gif');
  if (matches(bytes, 0, TIFF_LE) || matches(bytes, 0, TIFF_BE)) {
    return result('tiff', 'image/tiff');
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return result('webp', 'image/webp');
  if (ascii(bytes, 0, 'BM')) return result('bmp', 'image/bmp');
  if (matches(bytes, 0, ICO)) return result('ico', 'image/x-icon');

  if (
    ascii(bytes, 0, 'ID3') ||
    (length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0 && (bytes[1]! & 0x06) !== 0)
  ) {
    return result('audio', 'audio/mpeg');
  }
  if (ascii(bytes, 0, 'fLaC')) return result('audio', 'audio/flac');
  if (ascii(bytes, 0, 'OggS')) return result('audio', 'audio/ogg');
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return result('audio', 'audio/wav');

  if (length >= 8 && ascii(bytes, 4, 'ftyp')) {
    return ascii(bytes, 8, 'qt  ') ? result('video', 'video/quicktime') : result('video', 'video/mp4');
  }
  if (matches(bytes, 0, [0x1a, 0x45, 0xdf, 0xa3])) return result('video', 'video/webm', 0.9);

  // Executables are identified so callers can reject them before selecting a reader.
  if (matches(bytes, 0, PE)) return result('exe', 'application/vnd.microsoft.portable-executable');
  if (matches(bytes, 0, ELF)) return result('exe', 'application/x-elf');
  if (
    matches(bytes, 0, MACHO_BE_32) ||
    matches(bytes, 0, MACHO_LE_32) ||
    matches(bytes, 0, MACHO_BE_64) ||
    matches(bytes, 0, MACHO_LE_64) ||
    matches(bytes, 0, MACHO_FAT) ||
    matches(bytes, 0, MACHO_FAT_SWAPPED) ||
    matches(bytes, 0, MACHO_FAT_64) ||
    matches(bytes, 0, MACHO_FAT_64_SWAPPED)
  ) {
    return result('exe', 'application/x-mach-binary');
  }

  // Check fixed signatures first so embedded PDF text cannot override a binary type.
  const pdfLastOffset = Math.min(length - 5, PDF_SCAN_BYTES - 5);
  for (let pdfOffset = 0; pdfOffset <= pdfLastOffset; pdfOffset += 1) {
    if (
      bytes[pdfOffset] === 0x25 &&
      bytes[pdfOffset + 1] === 0x50 &&
      bytes[pdfOffset + 2] === 0x44 &&
      bytes[pdfOffset + 3] === 0x46 &&
      bytes[pdfOffset + 4] === 0x2d
    ) {
      return result('pdf', 'application/pdf', 0.99);
    }
  }

  return NONE;
}

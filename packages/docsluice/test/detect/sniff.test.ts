import { describe, expect, it } from 'vitest';
import { sniffMagic } from '../../src/detect/sniff.js';
import { fuzzDetect } from '../../fuzz/detect.fuzz.js';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

const signatures: Array<{
  name: string;
  sample: Uint8Array;
  kind: string;
  mimeType: string;
}> = [
  { name: 'PDF', sample: bytes(0x25, 0x50, 0x44, 0x46, 0x2d), kind: 'pdf', mimeType: 'application/pdf' },
  { name: 'zip local file', sample: bytes(0x50, 0x4b, 0x03, 0x04), kind: 'zip', mimeType: 'application/zip' },
  { name: 'empty zip', sample: bytes(0x50, 0x4b, 0x05, 0x06), kind: 'zip', mimeType: 'application/zip' },
  { name: 'spanned zip', sample: bytes(0x50, 0x4b, 0x07, 0x08), kind: 'zip', mimeType: 'application/zip' },
  {
    name: 'OLE compound file',
    sample: bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1),
    kind: 'ole',
    mimeType: 'application/x-ole-storage',
  },
  { name: 'RTF', sample: bytes(0x7b, 0x5c, 0x72, 0x74, 0x66), kind: 'rtf', mimeType: 'application/rtf' },
  { name: 'gzip', sample: bytes(0x1f, 0x8b), kind: 'gzip', mimeType: 'application/gzip' },
  {
    name: 'tar',
    sample: Uint8Array.from({ length: 262 }, (_, index) =>
      index >= 257 && index < 262 ? [0x75, 0x73, 0x74, 0x61, 0x72][index - 257]! : 0,
    ),
    kind: 'tar',
    mimeType: 'application/x-tar',
  },
  {
    name: 'PNG',
    sample: bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    kind: 'png',
    mimeType: 'image/png',
  },
  { name: 'JPEG', sample: bytes(0xff, 0xd8, 0xff), kind: 'jpeg', mimeType: 'image/jpeg' },
  { name: 'GIF87a', sample: bytes(0x47, 0x49, 0x46, 0x38, 0x37, 0x61), kind: 'gif', mimeType: 'image/gif' },
  { name: 'GIF89a', sample: bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61), kind: 'gif', mimeType: 'image/gif' },
  { name: 'little-endian TIFF', sample: bytes(0x49, 0x49, 0x2a, 0x00), kind: 'tiff', mimeType: 'image/tiff' },
  { name: 'big-endian TIFF', sample: bytes(0x4d, 0x4d, 0x00, 0x2a), kind: 'tiff', mimeType: 'image/tiff' },
  {
    name: 'WebP',
    sample: bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50),
    kind: 'webp',
    mimeType: 'image/webp',
  },
  { name: 'BMP', sample: bytes(0x42, 0x4d), kind: 'bmp', mimeType: 'image/bmp' },
  { name: 'ICO', sample: bytes(0x00, 0x00, 0x01, 0x00), kind: 'ico', mimeType: 'image/x-icon' },
  { name: 'MP3 ID3', sample: bytes(0x49, 0x44, 0x33), kind: 'audio', mimeType: 'audio/mpeg' },
  { name: 'MP3 frame', sample: bytes(0xff, 0xfb, 0x90, 0x64), kind: 'audio', mimeType: 'audio/mpeg' },
  { name: 'MP4', sample: bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70), kind: 'video', mimeType: 'video/mp4' },
  {
    name: 'MOV',
    sample: bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20),
    kind: 'video',
    mimeType: 'video/quicktime',
  },
  {
    name: 'WAV',
    sample: bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45),
    kind: 'audio',
    mimeType: 'audio/wav',
  },
  { name: 'OGG', sample: bytes(0x4f, 0x67, 0x67, 0x53), kind: 'audio', mimeType: 'audio/ogg' },
  { name: 'FLAC', sample: bytes(0x66, 0x4c, 0x61, 0x43), kind: 'audio', mimeType: 'audio/flac' },
  { name: 'WebM and MKV', sample: bytes(0x1a, 0x45, 0xdf, 0xa3), kind: 'video', mimeType: 'video/webm' },
  {
    name: 'Windows PE',
    sample: bytes(0x4d, 0x5a),
    kind: 'exe',
    mimeType: 'application/vnd.microsoft.portable-executable',
  },
  { name: 'ELF', sample: bytes(0x7f, 0x45, 0x4c, 0x46), kind: 'exe', mimeType: 'application/x-elf' },
  {
    name: 'Mach-O big-endian 32-bit',
    sample: bytes(0xfe, 0xed, 0xfa, 0xce),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O little-endian 32-bit',
    sample: bytes(0xce, 0xfa, 0xed, 0xfe),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O big-endian 64-bit',
    sample: bytes(0xfe, 0xed, 0xfa, 0xcf),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O little-endian 64-bit',
    sample: bytes(0xcf, 0xfa, 0xed, 0xfe),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O universal',
    sample: bytes(0xca, 0xfe, 0xba, 0xbe),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O universal byte-swapped',
    sample: bytes(0xbe, 0xba, 0xfe, 0xca),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O universal 64-bit',
    sample: bytes(0xca, 0xfe, 0xba, 0xbf),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
  {
    name: 'Mach-O universal 64-bit byte-swapped',
    sample: bytes(0xbf, 0xba, 0xfe, 0xca),
    kind: 'exe',
    mimeType: 'application/x-mach-binary',
  },
];

describe('sniffMagic', () => {
  it.each(signatures)('recognizes $name from its minimal signature', ({ sample, kind, mimeType }) => {
    const result = sniffMagic(sample);
    expect(result.kind).toBe(kind);
    expect(result.mimeType).toBe(mimeType);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('finds a PDF marker through byte 1023 but not after the first 1024 bytes', () => {
    const withinLimit = new Uint8Array(1024);
    withinLimit.set([0x25, 0x50, 0x44, 0x46, 0x2d], 1019);
    expect(sniffMagic(withinLimit).kind).toBe('pdf');

    const outsideLimit = new Uint8Array(1025);
    outsideLimit.set([0x25, 0x50, 0x44, 0x46, 0x2d], 1020);
    expect(sniffMagic(outsideLimit).kind).toBeNull();
  });

  it.each([
    { name: 'Windows PE', signature: bytes(0x4d, 0x5a) },
    { name: 'ELF', signature: bytes(0x7f, 0x45, 0x4c, 0x46) },
    { name: 'Mach-O', signature: bytes(0xfe, 0xed, 0xfa, 0xcf) },
  ])('prioritizes $name over an embedded PDF marker', ({ signature }) => {
    const input = new Uint8Array(1024);
    input.set(signature);
    input.set([0x25, 0x50, 0x44, 0x46, 0x2d], 256);

    expect(sniffMagic(input).kind).toBe('exe');
  });

  it('returns null for empty, random and non-matching input', () => {
    expect(sniffMagic(new Uint8Array()).kind).toBeNull();
    expect(sniffMagic(bytes(1, 2, 3, 4, 5, 6, 7, 8)).kind).toBeNull();
    expect(sniffMagic(bytes(0x50, 0x4b, 0x03, 0x05)).kind).toBeNull();
    expect(sniffMagic(bytes(0x1a, 0x45, 0xdf, 0xa4)).kind).toBeNull();

    for (let seed = 1; seed <= 32; seed += 1) {
      const random = new Uint8Array(64);
      let state = seed;
      for (let index = 0; index < random.length; index += 1) {
        state = (state * 1_103_515_245 + 12_345) >>> 0;
        random[index] = state >>> 16;
      }
      expect(sniffMagic(random).kind).toBeNull();
      expect(() => fuzzDetect(random)).not.toThrow();
    }
  });

  it('does not scan beyond the first 4 KB', () => {
    const input = new Uint8Array(4097);
    input.set([0x1f, 0x8b], 4095);
    expect(sniffMagic(input).kind).toBeNull();
  });
});

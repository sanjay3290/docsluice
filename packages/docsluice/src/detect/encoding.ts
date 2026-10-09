const SAMPLE_BYTES = 8 * 1024;

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252' | 'unsupported';

export interface EncodingDetection {
  isText: boolean;
  encoding: TextEncoding;
  warning?: 'ENCODING_GUESSED';
}

/** Determine whether the byte sample is text and choose a decoder. */
export function detectEncoding(bytes: Uint8Array): EncodingDetection {
  const length = Math.min(bytes.length, SAMPLE_BYTES);
  if (isKnownBinarySignature(bytes)) return { isText: false, encoding: 'utf-8' };
  if (hasPrefix(bytes, [0x00, 0x00, 0xfe, 0xff]) || hasPrefix(bytes, [0xff, 0xfe, 0x00, 0x00])) {
    return { isText: false, encoding: 'unsupported' };
  }
  if (hasPrefix(bytes, [0xef, 0xbb, 0xbf])) return { isText: true, encoding: 'utf-8' };
  if (hasPrefix(bytes, [0xff, 0xfe])) return { isText: true, encoding: 'utf-16le' };
  if (hasPrefix(bytes, [0xfe, 0xff])) return { isText: true, encoding: 'utf-16be' };

  const utf16 = detectUtf16(bytes, length);
  if (utf16 !== undefined) return { isText: true, encoding: utf16 };
  if (hasTooManyControls(bytes, length)) return { isText: false, encoding: 'utf-8' };

  if (isStrictUtf8(bytes, length)) return { isText: true, encoding: 'utf-8' };
  return { isText: true, encoding: 'windows-1252', warning: 'ENCODING_GUESSED' };
}

function isKnownBinarySignature(bytes: Uint8Array): boolean {
  return (
    hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x05, 0x06]) ||
    hasPrefix(bytes, [0x50, 0x4b, 0x07, 0x08])
  );
}

/** Decode a complete byte array using a previously detected encoding. */
export function decodeText(bytes: Uint8Array, encoding: TextEncoding): string {
  if (encoding === 'unsupported') throw new RangeError('Unsupported text encoding');
  return new TextDecoder(encoding, { fatal: false }).decode(bytes);
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) if (bytes[i] !== prefix[i]) return false;
  return true;
}

function detectUtf16(bytes: Uint8Array, length: number): 'utf-16le' | 'utf-16be' | undefined {
  let pairs = Math.floor(length / 2);
  if (pairs > 128) pairs = 128;
  if (pairs < 2) return undefined;
  let evenNuls = 0;
  let oddNuls = 0;
  let evenNonZero = 0;
  let oddNonZero = 0;
  let lePlausibleUnits = 0;
  let bePlausibleUnits = 0;
  for (let i = 0; i < pairs; i += 1) {
    const even = bytes[i * 2] ?? 0;
    const odd = bytes[i * 2 + 1] ?? 0;
    const leCodeUnit = even | (odd << 8);
    const beCodeUnit = (even << 8) | odd;
    if (even === 0) evenNuls += 1;
    else evenNonZero += 1;
    if (odd === 0) oddNuls += 1;
    else oddNonZero += 1;
    if (isPlausibleTextCodeUnit(leCodeUnit)) lePlausibleUnits += 1;
    if (isPlausibleTextCodeUnit(beCodeUnit)) bePlausibleUnits += 1;
  }
  if (oddNuls * 2 >= pairs && evenNonZero * 2 >= pairs && lePlausibleUnits * 5 >= pairs * 4)
    return 'utf-16le';
  if (evenNuls * 2 >= pairs && oddNonZero * 2 >= pairs && bePlausibleUnits * 5 >= pairs * 4)
    return 'utf-16be';
  return undefined;
}

function isPlausibleTextCodeUnit(codeUnit: number): boolean {
  return (
    codeUnit >= 0x20 ||
    codeUnit === 0x09 ||
    codeUnit === 0x0a ||
    codeUnit === 0x0c ||
    codeUnit === 0x0d ||
    (codeUnit >= 0xd800 && codeUnit <= 0xdfff)
  );
}

function hasTooManyControls(bytes: Uint8Array, length: number): boolean {
  if (length === 0) return false;
  let controls = 0;
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) controls += 1;
  }
  return controls / length > 0.3;
}

function isStrictUtf8(bytes: Uint8Array, length: number): boolean {
  // Include up to three bytes past the sample boundary so a truncated multibyte
  // sequence at byte 8192 is checked using the bytes that complete it.
  let end = length;
  if (length > 0) {
    let sequenceStart = length - 1;
    while (sequenceStart >= Math.max(0, length - 4) && isUtf8Continuation(bytes[sequenceStart] ?? 0)) {
      sequenceStart -= 1;
    }
    const lead = bytes[sequenceStart] ?? 0;
    const expectedLength =
      lead >= 0xc2 && lead <= 0xdf
        ? 2
        : lead >= 0xe0 && lead <= 0xef
          ? 3
          : lead >= 0xf0 && lead <= 0xf4
            ? 4
            : 1;
    const presentLength = length - sequenceStart;
    if (expectedLength > presentLength) end = Math.min(bytes.length, length + expectedLength - presentLength);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    return true;
  } catch {
    return false;
  }
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

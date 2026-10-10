import type { Budget } from '../../core/budget.js';

const COMPRESSED = 0x75465a4c; // "LZFu"
const UNCOMPRESSED = 0x414c454d; // "MELA"
const HEADER_SIZE = 16;
const DICTIONARY_SIZE = 4096;
/** [MS-OXRTFCP] 2.1.2.1: the dictionary starts with this 207-character RTF prefix. */
const INITIAL_DICTIONARY =
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript ' +
  '\\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n' +
  '\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';
/** One control byte and eight 2-byte references give at most 8 * 17 output bytes. */
const MAX_OUTPUT_PER_INPUT_BYTE = 8;

export interface DecompressedRtf {
  bytes: Uint8Array;
  /** The stream ended, failed its checksum or claimed a size it did not hold; `bytes` is what was read. */
  damaged: boolean;
}

/** CRC-32 as [MS-OXRTFCP] 2.1.3.2 defines it: reflected polynomial, no initial or final inversion. */
function crc32(bytes: Uint8Array, budget: Budget): number {
  let crc = 0;
  for (let index = 0; index < bytes.length; index++) {
    if ((index & 0xfff) === 0) budget.tick();
    crc ^= bytes[index]!;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
}

/**
 * Decompress a PR_RTF_COMPRESSED stream ([MS-OXRTFCP]). The output buffer is sized from what the
 * input can really produce, never from the declared raw size alone, and is charged to the shared
 * uncompressed-byte and ratio limits. Returns `undefined` when the header is unusable or a limit
 * stops the read.
 */
export function decompressRtf(bytes: Uint8Array, budget: Budget): DecompressedRtf | undefined {
  budget.tick();
  if (bytes.length < HEADER_SIZE) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const compressedSize = view.getUint32(0, true);
  const rawSize = view.getUint32(4, true);
  const type = view.getUint32(8, true);
  const crc = view.getUint32(12, true);
  if (compressedSize < HEADER_SIZE - 4) return undefined;
  // COMPSIZE counts the bytes after itself; a stream shorter than it claims is read as far as it goes.
  const end = Math.min(bytes.length, 4 + compressedSize);
  let damaged = end < 4 + compressedSize;
  const payload = bytes.subarray(HEADER_SIZE, end);

  if (type === UNCOMPRESSED) {
    const size = Math.min(rawSize, payload.length);
    if (size < rawSize) damaged = true;
    if (!budget.checkUncompressed(size) || !budget.addUncompressed(size)) return undefined;
    return { bytes: payload.slice(0, size), damaged };
  }
  if (type !== COMPRESSED) return undefined;
  if (crc32(payload, budget) !== crc) damaged = true;

  const capacity = Math.min(rawSize, payload.length * MAX_OUTPUT_PER_INPUT_BYTE);
  if (capacity < rawSize) damaged = true;
  if (!budget.checkRatio(payload.length, capacity) || !budget.checkUncompressed(capacity)) return undefined;
  const output = new Uint8Array(capacity);
  const dictionary = new Uint8Array(DICTIONARY_SIZE);
  for (let index = 0; index < INITIAL_DICTIONARY.length; index++) {
    dictionary[index] = INITIAL_DICTIONARY.charCodeAt(index);
  }
  let write = INITIAL_DICTIONARY.length;
  let length = 0;
  let input = 0;
  let finished = false;
  while (!finished && input < payload.length && length < capacity) {
    budget.tick();
    const control = payload[input++]!;
    for (let bit = 0; bit < 8 && length < capacity; bit++) {
      if (input >= payload.length) {
        finished = true;
        break;
      }
      if ((control & (1 << bit)) === 0) {
        const byte = payload[input++]!;
        output[length++] = byte;
        dictionary[write] = byte;
        write = (write + 1) & 0xfff;
        continue;
      }
      if (input + 1 >= payload.length) {
        damaged = true;
        finished = true;
        break;
      }
      const reference = (payload[input]! << 8) | payload[input + 1]!;
      input += 2;
      let read = reference >>> 4;
      // A reference to the write position is the end marker.
      if (read === write) {
        finished = true;
        break;
      }
      const count = (reference & 0xf) + 2;
      for (let index = 0; index < count && length < capacity; index++) {
        const byte = dictionary[read]!;
        read = (read + 1) & 0xfff;
        output[length++] = byte;
        dictionary[write] = byte;
        write = (write + 1) & 0xfff;
      }
    }
  }
  if (length < rawSize) damaged = true;
  if (!budget.addUncompressed(length)) return undefined;
  return { bytes: output.subarray(0, length), damaged };
}

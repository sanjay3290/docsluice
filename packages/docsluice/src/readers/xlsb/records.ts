import type { Budget } from '../../core/budget.js';
import { CorruptFileError, LimitExceededError } from '../../core/errors.js';

const MAX_RECORDS = 1_000_000;
const MAX_WIDE_STRING_CODE_UNITS = 1_000_000;
const NULL_STRING_LENGTH = 0xffff_ffff;
const MIN_NORMAL_XNUM = 2.2250738585072014e-308;

export interface XlsbRecord {
  /** The 7-bit continuation-coded MS-XLSB record type. */
  readonly type: number;
  /** A view of the record payload; it shares the input byte buffer. */
  readonly data: Uint8Array;
  /** Byte offset of the record's first type byte in the source stream. */
  readonly offset: number;
}

/**
 * Iterate binary records from an XLSB part.
 *
 * Record types use one or two bytes; record sizes use one through four bytes.
 * The iterator accepts unknown type ids so callers can skip records they do not
 * interpret. It bounds streams to one million records.
 */
export function* iterXlsbRecords(bytes: Uint8Array, budget: Budget): Generator<XlsbRecord> {
  let offset = 0;
  let count = 0;
  while (offset < bytes.length) {
    budget.tick();
    if (count >= MAX_RECORDS) throw new LimitExceededError('xlsbRecordCount', MAX_RECORDS);
    const recordOffset = offset;
    const typeFirst = readHeaderByte(bytes, offset, budget);
    offset += 1;
    let type = typeFirst & 0x7f;
    if ((typeFirst & 0x80) !== 0) {
      const typeHigh = readHeaderByte(bytes, offset, budget);
      offset += 1;
      if ((typeHigh & 0x80) !== 0) throw corrupt();
      type |= (typeHigh & 0x7f) << 7;
      if (type < 128) throw corrupt();
    }

    let size = 0;
    let shift = 0;
    let sizeByte: number;
    for (let index = 0; index < 4; index += 1) {
      sizeByte = readHeaderByte(bytes, offset, budget);
      offset += 1;
      size += (sizeByte & 0x7f) * 2 ** shift;
      if ((sizeByte & 0x80) === 0 || index === 3) break;
      shift += 7;
    }

    if (size > bytes.length - offset) throw corrupt();
    const dataStart = offset;
    const dataEnd = dataStart + size;
    const data = bytes.subarray(dataStart, dataEnd);
    offset = dataEnd;
    count += 1;
    yield { type, data, offset: recordOffset };
  }
}

/** A bounded little-endian cursor for common MS-XLSB record fields. */
export class XlsbCursor {
  readonly #bytes: Uint8Array;
  readonly #view: DataView;
  readonly #budget: Budget;
  #offset = 0;

  constructor(bytes: Uint8Array, budget: Budget) {
    this.#bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.#budget = budget;
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset;
  }

  readU8(): number {
    const start = this.#advance(1);
    return this.#view.getUint8(start);
  }

  readU16(): number {
    const start = this.#advance(2);
    return this.#view.getUint16(start, true);
  }

  readU32(): number {
    const start = this.#advance(4);
    return this.#view.getUint32(start, true);
  }

  readF64(): number {
    const start = this.#advance(8);
    const value = this.#view.getFloat64(start, true);
    if (
      !Number.isFinite(value) ||
      (value !== 0 && Math.abs(value) < MIN_NORMAL_XNUM) ||
      Object.is(value, -0)
    ) {
      throw corrupt();
    }
    return value;
  }

  /** Read a length-prefixed MS-XLSB XLWideString. */
  readWideString(): string {
    const codeUnits = this.readU32();
    if (codeUnits === NULL_STRING_LENGTH) throw corrupt();
    return this.#decodeWideString(codeUnits);
  }

  /** Read a length-prefixed XLNullableWideString; the all-ones count is null. */
  readNullableWideString(): string | null {
    const codeUnits = this.readU32();
    if (codeUnits === NULL_STRING_LENGTH) return null;
    return this.#decodeWideString(codeUnits);
  }

  #decodeWideString(codeUnits: number): string {
    if (codeUnits > MAX_WIDE_STRING_CODE_UNITS)
      throw new LimitExceededError('xlsbStringCodeUnits', MAX_WIDE_STRING_CODE_UNITS);
    const byteLength = codeUnits * 2;
    if (byteLength > this.remaining) throw corrupt();
    const bytes = this.#consumeBytes(byteLength);
    try {
      return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw corrupt();
    }
  }

  #consumeBytes(length: number): Uint8Array {
    const start = this.#advance(length);
    return this.#bytes.subarray(start, this.#offset);
  }

  #advance(length: number): number {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) throw corrupt();
    for (let index = 0; index < length; index += 1) this.#budget.tick();
    const start = this.#offset;
    this.#offset += length;
    return start;
  }
}

function readHeaderByte(bytes: Uint8Array, offset: number, budget: Budget): number {
  if (offset >= bytes.length) throw corrupt();
  budget.tick();
  return bytes[offset]!;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The XLSB binary record data is invalid.');
}

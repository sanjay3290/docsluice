import type { Budget } from '../../core/budget.js';

/** BIFF8 caps record data at 8,224 bytes ([MS-XLS] 2.1.4); a longer claim is a length lie. */
export const MAX_RECORD_LENGTH = 8224;

export const RECORD = {
  BOF: 0x0809,
  EOF: 0x000a,
  CONTINUE: 0x003c,
  FILEPASS: 0x002f,
  DATEMODE: 0x0022,
  FORMAT: 0x041e,
  XF: 0x00e0,
  BOUNDSHEET8: 0x0085,
  SST: 0x00fc,
  LABELSST: 0x00fd,
  LABEL: 0x0204,
  RSTRING: 0x00d6,
  NUMBER: 0x0203,
  RK: 0x027e,
  MULRK: 0x00bd,
  BOOLERR: 0x0205,
  FORMULA: 0x0006,
  STRING: 0x0207,
  MERGECELLS: 0x00e5,
  ROW: 0x0208,
  COLINFO: 0x007d,
  NOTE: 0x001c,
  OBJ: 0x005d,
  TXO: 0x01b6,
  NAME: 0x0018,
  EXTERNSHEET: 0x0017,
} as const;

export interface BiffRecord {
  type: number;
  /** Offset of the record header in the stream. */
  offset: number;
  data: Uint8Array;
}

/**
 * Records from `start` in a BIFF stream, one at a time. Iteration stops at the end of the stream or
 * at a record whose length runs past it or exceeds the BIFF8 maximum; `damaged` then says why.
 */
export class RecordReader {
  #stream: Uint8Array;
  #view: DataView;
  #position: number;
  #budget: Budget;
  damaged = false;

  constructor(stream: Uint8Array, start: number, budget: Budget) {
    this.#stream = stream;
    this.#view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
    this.#position = start;
    this.#budget = budget;
  }

  get position(): number {
    return this.#position;
  }

  /** The type of the next record without consuming it, or `undefined` at the end. */
  peekType(): number | undefined {
    if (this.#position + 4 > this.#stream.length) return undefined;
    return this.#view.getUint16(this.#position, true);
  }

  next(): BiffRecord | undefined {
    this.#budget.tick();
    if (this.#position + 4 > this.#stream.length) return undefined;
    const offset = this.#position;
    const type = this.#view.getUint16(offset, true);
    const length = this.#view.getUint16(offset + 2, true);
    if (length > MAX_RECORD_LENGTH || offset + 4 + length > this.#stream.length) {
      this.damaged = true;
      this.#position = this.#stream.length;
      return undefined;
    }
    this.#position = offset + 4 + length;
    return { type, offset, data: this.#stream.subarray(offset + 4, offset + 4 + length) };
  }
}

/** Little-endian reads from one record's data; out-of-range reads return `undefined`. */
export function u16(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 2 > data.length) return undefined;
  return data[offset]! | (data[offset + 1]! << 8);
}

export function u32(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 4 > data.length) return undefined;
  return (
    (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0
  );
}

export function f64(data: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + 8 > data.length) return undefined;
  return new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, true);
}

/** An RK number ([MS-XLS] 2.5.217): a 30-bit integer or the top 30 bits of a double, optionally /100. */
export function rkNumber(rk: number): number {
  const value =
    rk & 2 ? rk >> 2 : new DataView(Uint32Array.of(0, rk & 0xffff_fffc).buffer).getFloat64(0, true);
  return rk & 1 ? value / 100 : value;
}

/**
 * Reads data that continues across `CONTINUE` records. Unicode character arrays are special: when
 * one is split, the continuation starts with a new high-byte flag ([MS-XLS] 2.5.293).
 */
export class ContinuedReader {
  #segments: Uint8Array[];
  #segment = 0;
  #offset = 0;
  #budget: Budget;
  /** A read ran past the last segment. */
  exhausted = false;

  constructor(segments: Uint8Array[], budget: Budget) {
    this.#segments = segments;
    this.#budget = budget;
  }

  /** Move to the next segment when the current one is used up. */
  #ensure(): boolean {
    while (this.#segment < this.#segments.length && this.#offset >= this.#segments[this.#segment]!.length) {
      this.#budget.tick();
      this.#segment++;
      this.#offset = 0;
    }
    if (this.#segment >= this.#segments.length) {
      this.exhausted = true;
      return false;
    }
    return true;
  }

  u8(): number | undefined {
    if (!this.#ensure()) return undefined;
    return this.#segments[this.#segment]![this.#offset++];
  }

  u16(): number | undefined {
    const low = this.u8();
    const high = this.u8();
    return low === undefined || high === undefined ? undefined : low | (high << 8);
  }

  u32(): number | undefined {
    const low = this.u16();
    const high = this.u16();
    return low === undefined || high === undefined ? undefined : (low | (high << 16)) >>> 0;
  }

  /** Skip bytes that may span segments (rich-text runs, phonetic data). */
  skip(count: number): void {
    let remaining = count;
    while (remaining > 0) {
      if (!this.#ensure()) return;
      const segment = this.#segments[this.#segment]!;
      const step = Math.min(remaining, segment.length - this.#offset);
      this.#offset += step;
      remaining -= step;
    }
  }

  /** `count` characters, 1 or 2 bytes each, re-reading the high-byte flag at each segment start. */
  characters(count: number, highByte: boolean): string | undefined {
    let wide = highByte;
    let text = '';
    let remaining = count;
    while (remaining > 0) {
      this.#budget.tick();
      let segment = this.#segments[this.#segment];
      if (!segment || this.#offset >= segment.length) {
        // The characters go on in the next record, which starts with a fresh high-byte flag.
        this.#segment++;
        segment = this.#segments[this.#segment];
        if (!segment || segment.length === 0) {
          this.exhausted = true;
          return undefined;
        }
        wide = (segment[0]! & 1) === 1;
        this.#offset = 1;
      }
      const width = wide ? 2 : 1;
      const take = Math.min(Math.floor((segment.length - this.#offset) / width), remaining);
      if (take === 0) {
        if (this.#offset >= segment.length) continue;
        // A wide character cannot straddle a record boundary: the data is damaged.
        this.exhausted = true;
        return undefined;
      }
      for (let index = 0; index < take; index++) {
        const at = this.#offset + index * width;
        text += String.fromCharCode(wide ? segment[at]! | (segment[at + 1]! << 8) : segment[at]!);
      }
      this.#offset += take * width;
      remaining -= take;
    }
    return text;
  }

  /**
   * An `XLUnicodeRichExtendedString` ([MS-XLS] 2.5.293), as in the SST: length, flags, optional run
   * and phonetic counts, characters, then the runs and phonetic data, which are skipped.
   */
  richExtendedString(): string | undefined {
    const length = this.u16();
    const flags = this.u8();
    if (length === undefined || flags === undefined) return undefined;
    const runs = flags & 8 ? this.u16() : 0;
    const phonetic = flags & 4 ? this.u32() : 0;
    if (runs === undefined || phonetic === undefined) return undefined;
    const text = this.characters(length, (flags & 1) === 1);
    if (text === undefined) return undefined;
    this.skip(runs * 4);
    this.skip(phonetic);
    return text;
  }
}

/** An `XLUnicodeString` inside one record ([MS-XLS] 2.5.294); `lengthBytes` is 1 for the short form. */
export function recordString(
  data: Uint8Array,
  offset: number,
  lengthBytes: 1 | 2,
): { text: string; end: number } | undefined {
  const length = lengthBytes === 1 ? data[offset] : u16(data, offset);
  const flags = data[offset + lengthBytes];
  if (length === undefined || flags === undefined) return undefined;
  const wide = (flags & 1) === 1;
  const start = offset + lengthBytes + 1;
  const end = start + length * (wide ? 2 : 1);
  if (end > data.length) return undefined;
  let text = '';
  for (let index = 0; index < length; index++) {
    const at = start + index * (wide ? 2 : 1);
    text += String.fromCharCode(wide ? data[at]! | (data[at + 1]! << 8) : data[at]!);
  }
  return { text, end };
}

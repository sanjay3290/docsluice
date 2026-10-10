import type { Budget } from '../../core/budget.js';

/** Record types used by the reader ([MS-XLSB] 2.3). */
export const BRT = {
  RowHdr: 0,
  CellBlank: 1,
  CellRk: 2,
  CellError: 3,
  CellBool: 4,
  CellReal: 5,
  CellSt: 6,
  CellIsst: 7,
  FmlaString: 8,
  FmlaNum: 9,
  FmlaBool: 10,
  FmlaError: 11,
  // Short cell records omit the column: the cell follows the previous one in its row.
  ShortBlank: 12,
  ShortRk: 13,
  ShortError: 14,
  ShortBool: 15,
  ShortReal: 16,
  ShortSt: 17,
  ShortIsst: 18,
  SSTItem: 19,
  CellRString: 62,
  Fmt: 44,
  XF: 47,
  BeginSheetData: 145,
  EndSheetData: 146,
  WbProp: 153,
  BundleSh: 156,
  BeginSst: 159,
  MergeCell: 176,
  BeginCellXFs: 617,
  EndCellXFs: 618,
} as const;

export interface XlsbRecord {
  type: number;
  data: Uint8Array;
}

/**
 * Iterate the records of an XLSB part ([MS-XLSB] 2.1.4): a 1–2 byte type and a 1–4 byte size, each
 * seven bits per byte, low bits first. A record whose size runs past the part ends the iteration and
 * sets `damaged`. Every record ticks the budget.
 */
export class XlsbRecords {
  #offset = 0;
  damaged = false;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly budget: Budget,
  ) {}

  next(): XlsbRecord | undefined {
    this.budget.tick();
    const bytes = this.bytes;
    let offset = this.#offset;
    if (offset >= bytes.length) return undefined;
    let type = bytes[offset++]!;
    if (type & 0x80) {
      if (offset >= bytes.length) return this.#damage();
      type = (type & 0x7f) | ((bytes[offset++]! & 0x7f) << 7);
    }
    let size = 0;
    for (let index = 0; index < 4; index++) {
      if (offset >= bytes.length) return this.#damage();
      const byte = bytes[offset++]!;
      size |= (byte & 0x7f) << (7 * index);
      if ((byte & 0x80) === 0) break;
    }
    size >>>= 0;
    if (size > bytes.length - offset) return this.#damage();
    this.#offset = offset + size;
    return { type, data: bytes.subarray(offset, offset + size) };
  }

  #damage(): undefined {
    this.damaged = true;
    this.#offset = this.bytes.length;
    return undefined;
  }
}

export function u16(data: Uint8Array, offset: number): number | undefined {
  return offset + 2 <= data.length ? data[offset]! | (data[offset + 1]! << 8) : undefined;
}

export function u32(data: Uint8Array, offset: number): number | undefined {
  return offset + 4 <= data.length
    ? (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0
    : undefined;
}

export function f64(data: Uint8Array, offset: number): number | undefined {
  return offset + 8 <= data.length
    ? new DataView(data.buffer, data.byteOffset + offset, 8).getFloat64(0, true)
    : undefined;
}

/**
 * An `XLWideString` (or `XLNullableWideString`, whose 0xFFFFFFFF length is `null`): a 4-byte
 * character count and UTF-16LE text. A count past the record end is `undefined`.
 */
export function wideString(
  data: Uint8Array,
  offset: number,
): { text: string | null; end: number } | undefined {
  const count = u32(data, offset);
  if (count === undefined) return undefined;
  if (count === 0xffff_ffff) return { text: null, end: offset + 4 };
  const end = offset + 4 + count * 2;
  if (end > data.length) return undefined;
  return { text: new TextDecoder('utf-16le').decode(data.subarray(offset + 4, end)), end };
}

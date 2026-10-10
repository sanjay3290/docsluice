import type { Budget } from '../../core/budget.js';

/** Tags read from a TIFF or EXIF structure (TIFF 6.0, EXIF 2.32, CIPA DC-008). */
export interface TiffInfo {
  width?: number;
  height?: number;
  orientation?: number;
  make?: string;
  model?: string;
  /** `DateTimeOriginal`, else `DateTime`, as ISO 8601 (with the EXIF offset when one is given). */
  taken?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  /** An IFD offset, entry or value pointed outside the data or back at an IFD already read. */
  damaged: boolean;
}

/** IFD entries read per directory at most; a larger declared count is damage, not a loop. */
const MAX_ENTRIES = 1_024;
/** Directories read at most: IFD0, its chain, and the EXIF and GPS sub-IFDs. */
const MAX_DIRECTORIES = 16;
/** ASCII values longer than this are cut. */
const MAX_TEXT = 256;
const TYPE_SIZES = new Map([
  [1, 1],
  [2, 1],
  [3, 2],
  [4, 4],
  [5, 8],
  [7, 1],
  [9, 4],
  [10, 8],
]);

interface Entry {
  tag: number;
  type: number;
  count: number;
  /** Offset of the value bytes in `data`. */
  value: number;
}

class Reader {
  constructor(
    readonly data: Uint8Array,
    readonly little: boolean,
  ) {}

  u16(offset: number): number | undefined {
    if (offset < 0 || offset + 2 > this.data.length) return undefined;
    const a = this.data[offset]!;
    const b = this.data[offset + 1]!;
    return this.little ? a | (b << 8) : (a << 8) | b;
  }

  u32(offset: number): number | undefined {
    if (offset < 0 || offset + 4 > this.data.length) return undefined;
    const view = new DataView(this.data.buffer, this.data.byteOffset + offset, 4);
    return view.getUint32(0, this.little);
  }
}

function entries(
  reader: Reader,
  offset: number,
  budget: Budget,
  info: TiffInfo,
): { list: Entry[]; next: number } {
  const count = reader.u16(offset);
  if (count === undefined || count > MAX_ENTRIES || offset + 2 + count * 12 > reader.data.length) {
    info.damaged = true;
    return { list: [], next: 0 };
  }
  const list: Entry[] = [];
  for (let index = 0; index < count; index++) {
    budget.tick();
    const at = offset + 2 + index * 12;
    const tag = reader.u16(at)!;
    const type = reader.u16(at + 2)!;
    const valueCount = reader.u32(at + 4)!;
    const size = (TYPE_SIZES.get(type) ?? 0) * valueCount;
    // Values of four bytes or less sit in the entry; longer ones are at an offset.
    const value = size <= 4 ? at + 8 : reader.u32(at + 8)!;
    if (size === 0 || value + size > reader.data.length) {
      if (size > 4) info.damaged = true;
      continue;
    }
    list.push({ tag, type, count: valueCount, value });
  }
  return { list, next: reader.u32(offset + 2 + count * 12) ?? 0 };
}

function number(reader: Reader, entry: Entry): number | undefined {
  if (entry.type === 3) return reader.u16(entry.value);
  if (entry.type === 4) return reader.u32(entry.value);
  return undefined;
}

function text(reader: Reader, entry: Entry): string | undefined {
  if (entry.type !== 2) return undefined;
  let end = entry.value;
  const limit = Math.min(entry.value + entry.count, entry.value + MAX_TEXT);
  while (end < limit && reader.data[end] !== 0) end++;
  let value = '';
  for (let index = entry.value; index < end; index++) {
    const code = reader.data[index]!;
    value += code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : '?';
  }
  return value.trim() || undefined;
}

function rational(reader: Reader, offset: number): number | undefined {
  const numerator = reader.u32(offset);
  const denominator = reader.u32(offset + 4);
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return numerator / denominator;
}

/** Degrees, minutes, seconds as three RATIONALs, signed by an `S`/`W` reference. */
function coordinate(
  reader: Reader,
  entry: Entry | undefined,
  reference: string | undefined,
): number | undefined {
  if (!entry || entry.type !== 5 || entry.count < 3) return undefined;
  const degrees = rational(reader, entry.value);
  const minutes = rational(reader, entry.value + 8);
  const seconds = rational(reader, entry.value + 16);
  if (degrees === undefined || minutes === undefined || seconds === undefined) return undefined;
  const value = degrees + minutes / 60 + seconds / 3600;
  return Math.round((reference === 'S' || reference === 'W' ? -value : value) * 1e7) / 1e7;
}

/** `YYYY:MM:DD HH:MM:SS` (EXIF) as ISO 8601, with an offset such as `+02:00` when known. */
export function exifDate(value: string | undefined, offset: string | undefined): string | undefined {
  if (value === undefined || value.length < 19) return undefined;
  const digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
  for (const index of digits) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
  }
  if (value.slice(0, 10) === '0000:00:00') return undefined;
  const iso = `${value.slice(0, 4)}-${value.slice(5, 7)}-${value.slice(8, 10)}T${value.slice(11, 19)}`;
  const zone = offset !== undefined && /^[+-]\d\d:\d\d$/.test(offset) ? offset : '';
  return `${iso}${zone}`;
}

/**
 * Read IFD0 and its EXIF and GPS sub-IFDs from a TIFF structure (a TIFF file, a JPEG APP1 `Exif`
 * block or a WebP/PNG EXIF chunk). Directories are visited at most once each, entry counts and
 * value offsets are checked against the data, and nothing recurses.
 */
export function readTiff(data: Uint8Array, budget: Budget): TiffInfo | undefined {
  budget.tick();
  if (data.length < 8) return undefined;
  const order = String.fromCharCode(data[0]!, data[1]!);
  if (order !== 'II' && order !== 'MM') return undefined;
  const reader = new Reader(data, order === 'II');
  if (reader.u16(2) !== 42) return undefined;
  const info: TiffInfo = { damaged: false };
  const visited = new Set<number>();
  const pending: Array<{ offset: number; kind: 'ifd0' | 'exif' | 'gps' }> = [
    { offset: reader.u32(4)!, kind: 'ifd0' },
  ];
  let first = true;
  let gpsEntries: Entry[] = [];
  let dateTime: string | undefined;
  let original: string | undefined;
  let originalOffset: string | undefined;
  while (pending.length > 0) {
    budget.tick();
    const { offset, kind } = pending.shift()!;
    if (offset === 0) continue;
    if (visited.has(offset) || visited.size >= MAX_DIRECTORIES || offset < 8 || offset >= data.length) {
      info.damaged = true;
      continue;
    }
    visited.add(offset);
    const { list, next } = entries(reader, offset, budget, info);
    if (kind === 'gps') {
      gpsEntries = list;
      continue;
    }
    for (const entry of list) {
      budget.tick();
      if (kind === 'ifd0' && first) {
        if (entry.tag === 256) info.width = number(reader, entry);
        else if (entry.tag === 257) info.height = number(reader, entry);
        else if (entry.tag === 271) info.make = text(reader, entry);
        else if (entry.tag === 272) info.model = text(reader, entry);
        else if (entry.tag === 274) info.orientation = number(reader, entry);
        else if (entry.tag === 306) dateTime = text(reader, entry);
        else if (entry.tag === 34665) pending.push({ offset: number(reader, entry) ?? 0, kind: 'exif' });
        else if (entry.tag === 34853) pending.push({ offset: number(reader, entry) ?? 0, kind: 'gps' });
      } else if (kind === 'exif') {
        if (entry.tag === 36867) original = text(reader, entry);
        else if (entry.tag === 36881) originalOffset = text(reader, entry);
      }
    }
    // Later IFD0 chain entries (thumbnails, further pages) are visited for loops but not read.
    if (kind === 'ifd0') {
      first = false;
      pending.push({ offset: next, kind: 'ifd0' });
    }
  }
  info.taken = exifDate(original, originalOffset) ?? exifDate(dateTime, undefined);
  const find = (tag: number) => gpsEntries.find((entry) => entry.tag === tag);
  const latitudeRef = find(1);
  const longitudeRef = find(3);
  info.latitude = coordinate(reader, find(2), latitudeRef ? text(reader, latitudeRef) : undefined);
  info.longitude = coordinate(reader, find(4), longitudeRef ? text(reader, longitudeRef) : undefined);
  const altitude = find(6);
  if (altitude?.type === 5) {
    const value = rational(reader, altitude.value);
    const below = find(5);
    if (value !== undefined) info.altitude = below && data[below.value] === 1 ? -value : value;
  }
  return info;
}

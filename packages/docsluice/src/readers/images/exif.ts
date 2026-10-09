import type { ReadContext } from '../../core/reader.js';

export interface ExifData {
  width?: number;
  height?: number;
  created?: string;
  orientation?: number;
  make?: string;
  model?: string;
  latitude?: string;
  longitude?: string;
  malformed: boolean;
}

type DirectoryKind = 'ifd0' | 'exif' | 'gps';
interface DirectoryRef {
  offset: number;
  kind: DirectoryKind;
}
interface Entry {
  type: number;
  count: number;
  value: number;
  inline: number;
}

const MAX_TEXT_BYTES = 256;

function inRange(bytes: Uint8Array, offset: number, length: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    offset >= 0 &&
    length >= 0 &&
    offset <= bytes.length &&
    length <= bytes.length - offset
  );
}

function asciiAt(bytes: Uint8Array, offset: number, expected: string): boolean {
  if (!inRange(bytes, offset, expected.length)) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (bytes[offset + index] !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function readAscii(bytes: Uint8Array, entry: Entry, inlineOffset: number): string | undefined {
  if (entry.type !== 2 || entry.count === 0 || entry.count > MAX_TEXT_BYTES) return undefined;
  const source = entry.count <= 4 ? inlineOffset : entry.value;
  if (!inRange(bytes, source, entry.count)) return undefined;
  const slice = bytes.subarray(source, source + entry.count);
  const end = slice.indexOf(0);
  return new TextDecoder('ascii').decode(end < 0 ? slice : slice.subarray(0, end)).trim();
}

function readUnsigned(
  bytes: Uint8Array,
  entry: Entry,
  inlineOffset: number,
  little: boolean,
  ctx: ReadContext,
): number[] | undefined {
  const unit = entry.type === 1 ? 1 : entry.type === 3 ? 2 : entry.type === 4 ? 4 : 0;
  if (unit === 0 || entry.count === 0 || entry.count > 3) return undefined;
  const size = unit * entry.count;
  const source = size <= 4 ? inlineOffset : entry.value;
  if (!inRange(bytes, source, size)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let index = 0; index < entry.count; index += 1) {
    ctx.budget.tick();
    const offset = source + index * unit;
    const value =
      unit === 1
        ? view.getUint8(offset)
        : unit === 2
          ? view.getUint16(offset, little)
          : view.getUint32(offset, little);
    values.push(value);
  }
  return values;
}

function readRationals(
  bytes: Uint8Array,
  entry: Entry,
  little: boolean,
  ctx: ReadContext,
): number[] | undefined {
  if (entry.type !== 5 || entry.count !== 3 || !inRange(bytes, entry.value, 24)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const values: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    ctx.budget.tick();
    const numerator = view.getUint32(entry.value + index * 8, little);
    const denominator = view.getUint32(entry.value + index * 8 + 4, little);
    if (denominator === 0) return undefined;
    values.push(numerator / denominator);
  }
  return values;
}

function parseCaptureDate(value: string | undefined): string | undefined {
  if (!value || value.length < 19) return undefined;
  const positions = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];
  for (const position of positions) {
    const code = value.charCodeAt(position);
    if (code < 48 || code > 57) return undefined;
  }
  if (value[4] !== ':' || value[7] !== ':' || value[10] !== ' ' || value[13] !== ':' || value[16] !== ':')
    return undefined;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 60)
    return undefined;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > daysInMonth[month - 1]!) return undefined;
  const yyyy = String(year).padStart(4, '0');
  return `${yyyy}-${value.slice(5, 7)}-${value.slice(8, 10)}T${value.slice(11, 19)}`;
}

function formatGps(
  ref: string | undefined,
  dms: number[] | undefined,
  maximum: number,
  ctx: ReadContext,
): string | undefined {
  if (!ref || !dms || dms[0]! > maximum || dms[1]! >= 60 || dms[2]! >= 60) return undefined;
  if (dms[0] === maximum && (dms[1] !== 0 || dms[2] !== 0)) return undefined;
  if ((maximum === 90 && ref !== 'N' && ref !== 'S') || (maximum === 180 && ref !== 'E' && ref !== 'W'))
    return undefined;
  const parts: string[] = [];
  for (const value of dms) {
    ctx.budget.tick();
    parts.push(Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6))));
  }
  return `${ref} ${parts[0]}° ${parts[1]}′ ${parts[2]}″`;
}

/** Parse only bounded IFD metadata. Unknown tags are skipped and no pixel data is decoded. */
export function parseExifTiff(bytes: Uint8Array, ctx: ReadContext, includeExif: boolean): ExifData {
  const result: ExifData = { malformed: false };
  const warn = () => {
    result.malformed = true;
  };
  if (!inRange(bytes, 0, 8) || !(asciiAt(bytes, 0, 'II') || asciiAt(bytes, 0, 'MM'))) {
    warn();
    return result;
  }
  const little = asciiAt(bytes, 0, 'II');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(2, little) !== 42) {
    warn();
    return result;
  }
  const first = view.getUint32(4, little);
  const pending: DirectoryRef[] = [{ offset: first, kind: 'ifd0' }];
  const visited = new Set<number>();
  let date: string | undefined;
  let latitudeRef: string | undefined;
  let longitudeRef: string | undefined;
  let latitude: number[] | undefined;
  let longitude: number[] | undefined;

  while (pending.length > 0) {
    ctx.budget.tick();
    const current = pending.pop()!;
    if (visited.has(current.offset)) {
      warn();
      continue;
    }
    visited.add(current.offset);
    if (visited.size > 16 || !inRange(bytes, current.offset, 2)) {
      warn();
      continue;
    }
    const count = view.getUint16(current.offset, little);
    const entriesStart = current.offset + 2;
    const entriesBytes = count * 12;
    if (!Number.isSafeInteger(entriesBytes) || !inRange(bytes, entriesStart, entriesBytes + 4)) {
      warn();
      continue;
    }
    let exifPointer: number | undefined;
    let gpsPointer: number | undefined;
    for (let index = 0; index < count; index += 1) {
      ctx.budget.tick();
      const offset = entriesStart + index * 12;
      const tag = view.getUint16(offset, little);
      const type = view.getUint16(offset + 2, little);
      const valueCount = view.getUint32(offset + 4, little);
      const value = view.getUint32(offset + 8, little);
      const entry = { type, count: valueCount, value, inline: offset + 8 };
      // Follow later IFD0 links for cycle detection, but image dimensions and
      // top-level EXIF pointers belong only to the primary IFD0.
      if (current.kind === 'ifd0' && current.offset === first) {
        if (tag === 256 || tag === 257) {
          const values = readUnsigned(bytes, entry, offset + 8, little, ctx);
          if (!values || values.length !== 1 || values[0] === 0) warn();
          else if (tag === 256) result.width = values[0]!;
          else result.height = values[0]!;
        } else if (includeExif && tag === 274) {
          const orientation = readUnsigned(bytes, entry, offset + 8, little, ctx);
          if (orientation && orientation.length === 1 && orientation[0]! >= 1 && orientation[0]! <= 8)
            result.orientation = orientation[0]!;
          else warn();
        } else if (includeExif && tag === 271) {
          const make = readAscii(bytes, entry, offset + 8);
          if (make === undefined) warn();
          else result.make = make;
        } else if (includeExif && tag === 272) {
          const model = readAscii(bytes, entry, offset + 8);
          if (model === undefined) warn();
          else result.model = model;
        } else if (includeExif && tag === 34665) {
          const pointer = readUnsigned(bytes, entry, offset + 8, little, ctx);
          if (pointer?.length === 1) exifPointer = pointer[0];
          else warn();
        } else if (includeExif && tag === 34853) {
          const pointer = readUnsigned(bytes, entry, offset + 8, little, ctx);
          if (pointer?.length === 1) gpsPointer = pointer[0];
          else warn();
        }
      } else if (includeExif && current.kind === 'exif' && tag === 36867) {
        date = readAscii(bytes, entry, offset + 8);
        if (date === undefined) warn();
      } else if (includeExif && current.kind === 'gps') {
        if (tag === 1) latitudeRef = readAscii(bytes, entry, offset + 8);
        else if (tag === 2) {
          latitude = readRationals(bytes, entry, little, ctx);
          if (!latitude) warn();
        } else if (tag === 3) longitudeRef = readAscii(bytes, entry, offset + 8);
        else if (tag === 4) {
          longitude = readRationals(bytes, entry, little, ctx);
          if (!longitude) warn();
        }
      }
    }
    if (current.kind === 'ifd0') {
      const next = view.getUint32(entriesStart + entriesBytes, little);
      if (next !== 0) pending.push({ offset: next, kind: 'ifd0' });
      if (exifPointer !== undefined) pending.push({ offset: exifPointer, kind: 'exif' });
      if (gpsPointer !== undefined) pending.push({ offset: gpsPointer, kind: 'gps' });
    }
  }
  if (includeExif) {
    const created = parseCaptureDate(date);
    const formattedLatitude = formatGps(latitudeRef, latitude, 90, ctx);
    const formattedLongitude = formatGps(longitudeRef, longitude, 180, ctx);
    if (created) result.created = created;
    if (formattedLatitude) result.latitude = formattedLatitude;
    if (formattedLongitude) result.longitude = formattedLongitude;
  }
  return result;
}

export function isExifPayload(bytes: Uint8Array, offset: number, length: number): boolean {
  return inRange(bytes, offset, length) && asciiAt(bytes, offset, 'Exif\0\0');
}

export function hasAscii(bytes: Uint8Array, offset: number, expected: string): boolean {
  return asciiAt(bytes, offset, expected);
}

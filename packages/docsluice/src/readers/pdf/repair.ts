import type { Budget } from '../../core/budget.js';

const encoder = new TextEncoder();
const CATALOG = encoder.encode('/Catalog');
/** How far before `/Catalog` its `N G obj` header may start. */
const HEADER_WINDOW = 65_536;

const isSpace = (byte: number) =>
  byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09 || byte === 0x0c || byte === 0x00;
const isDigit = (byte: number) => byte >= 0x30 && byte <= 0x39;

/** The last index of `needle` in `bytes` at or before `from`, or -1. */
function lastIndexOf(bytes: Uint8Array, needle: Uint8Array, from: number, budget: Budget): number {
  for (let start = Math.min(from, bytes.length - needle.length); start >= 0; start--) {
    if ((start & 0xfff) === 0) budget.tick();
    let match = true;
    for (let offset = 0; offset < needle.length; offset++) {
      if (bytes[start + offset] !== needle[offset]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return -1;
}

/** Read the unsigned integer that ends just before `end` (after skipping spaces). */
function numberBefore(bytes: Uint8Array, end: number): { value: number; start: number } | undefined {
  let position = end;
  while (position > 0 && isSpace(bytes[position - 1]!) && end - position < 256) position--;
  const last = position;
  while (position > 0 && isDigit(bytes[position - 1]!) && last - position < 10) position--;
  if (position === last) return undefined;
  let value = 0;
  for (let index = position; index < last; index++) value = value * 10 + bytes[index]! - 0x30;
  return { value, start: position };
}

/**
 * A truncated PDF loses its cross-reference table and trailer, and the engine cannot find the
 * catalog without a trailer (PDF-9). Find the last `/Catalog` object and append a minimal trailer
 * that names it, so the engine's own reconstruction can index the objects that survived. Returns
 * undefined when no catalog object is found. The input is never changed.
 */
export function rebuildTrailer(bytes: Uint8Array, budget: Budget): Uint8Array | undefined {
  let from = bytes.length;
  // A few candidates: `/Catalog` can also appear as a value elsewhere.
  for (let attempt = 0; attempt < 8; attempt++) {
    budget.tick();
    const catalog = lastIndexOf(bytes, CATALOG, from - 1, budget);
    if (catalog < 0) return undefined;
    from = catalog;
    const after = bytes[catalog + CATALOG.length];
    if (after !== undefined && !isSpace(after) && after !== 0x2f && after !== 0x3e) continue;
    // Walk back to the nearest `obj` keyword and read `N G` before it.
    const floor = Math.max(0, catalog - HEADER_WINDOW);
    for (let position = catalog - 3; position >= floor; position--) {
      if ((position & 0xfff) === 0) budget.tick();
      if (bytes[position] !== 0x6f || bytes[position + 1] !== 0x62 || bytes[position + 2] !== 0x6a) continue;
      if (position === 0 || !isSpace(bytes[position - 1]!)) continue;
      const generation = numberBefore(bytes, position);
      const object = generation && numberBefore(bytes, generation.start);
      if (!generation || !object) break;
      const trailer = encoder.encode(`\ntrailer\n<< /Root ${object.value} ${generation.value} R >>\n%%EOF\n`);
      const repaired = new Uint8Array(bytes.length + trailer.length);
      repaired.set(bytes);
      repaired.set(trailer, bytes.length);
      return repaired;
    }
  }
  return undefined;
}

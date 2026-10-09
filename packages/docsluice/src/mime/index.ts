import type { Budget } from '../core/budget.js';

const MAX_HEADER_BYTES = 1_048_576;
const MAX_HEADER_FIELDS = 512;
const MAX_CONTENT_PARAMETERS = 256;
const MIME_CHUNK_BYTES = 4096;

export interface MediaType {
  readonly value: string;
  readonly parameters: Map<string, string>;
}

export interface MimePart {
  readonly headers: Map<string, string>;
  readonly contentType: MediaType;
  readonly disposition: MediaType;
  readonly contentId?: string;
  readonly filename?: string;
  readonly bytes?: Uint8Array;
  readonly parts: MimePart[];
}

export interface MimeMessage {
  readonly headers: Map<string, string>;
  readonly parts: MimePart[];
  readonly incomplete: boolean;
}

function decodeBase64(value: string, maxBytes: number, budget?: Budget): Uint8Array {
  const output = new Uint8Array(Math.min(maxBytes, Math.ceil((value.length * 3) / 4)));
  let bits = 0;
  let accumulator = 0;
  let written = 0;
  for (let index = 0; index < value.length; index++) {
    budget?.tick();
    const code = value.charCodeAt(index);
    if (code === 61) break;
    const digit =
      code >= 65 && code <= 90
        ? code - 65
        : code >= 97 && code <= 122
          ? code - 71
          : code >= 48 && code <= 57
            ? code + 4
            : code === 43 || code === 45
              ? 62
              : code === 47 || code === 95
                ? 63
                : -1;
    if (digit < 0) continue;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (written < output.length) output[written++] = (accumulator >>> bits) & 0xff;
    }
  }
  return output.slice(0, written);
}

function findWithin(value: string, char: string, start: number, end: number, budget?: Budget): number {
  for (let index = start; index < end; index++) {
    budget?.tick();
    if (value[index] === char) return index;
  }
  return -1;
}

function decodeEncodedWords(value: string, budget?: Budget): string {
  let output = '';
  let index = 0;
  while (index < value.length) {
    budget?.tick();
    if (value.startsWith('=?', index)) {
      const maxEnd = Math.min(value.length, index + 75);
      const charsetEnd = findWithin(value, '?', index + 2, maxEnd, budget);
      const encodingEnd = charsetEnd < 0 ? -1 : charsetEnd + 2;
      let wordEnd = -1;
      if (encodingEnd > 0 && value[encodingEnd] === '?') {
        for (let cursor = encodingEnd + 1; cursor + 1 < maxEnd; cursor++) {
          budget?.tick();
          if (value[cursor] === '?' && value[cursor + 1] === '=') {
            wordEnd = cursor;
            break;
          }
        }
      }
      if (
        charsetEnd > index + 2 &&
        encodingEnd === charsetEnd + 2 &&
        wordEnd >= 0 &&
        wordEnd + 2 - index <= 75
      ) {
        const charset = value.slice(index + 2, charsetEnd);
        const encoding = value[charsetEnd + 1]!.toUpperCase();
        const encoded = value.slice(encodingEnd + 1, wordEnd);
        let bytes: Uint8Array;
        if (encoding === 'B') bytes = decodeBase64(encoded, encoded.length, budget);
        else if (encoding === 'Q') {
          let qEncoded = '';
          for (let cursor = 0; cursor < encoded.length; cursor++) {
            budget?.tick();
            qEncoded += encoded[cursor] === '_' ? ' ' : encoded[cursor];
          }
          bytes = decodeQuotedPrintable(qEncoded, encoded.length, budget);
        } else {
          output += value[index]!;
          index++;
          continue;
        }
        output += decodeBytes(bytes, charset);
        index = wordEnd + 2;
        let whitespaceEnd = index;
        while (
          whitespaceEnd < value.length &&
          (value[whitespaceEnd] === ' ' ||
            value[whitespaceEnd] === '\t' ||
            value[whitespaceEnd] === '\r' ||
            value[whitespaceEnd] === '\n')
        ) {
          budget?.tick();
          whitespaceEnd++;
        }
        if (value.startsWith('=?', whitespaceEnd)) index = whitespaceEnd;
        continue;
      }
    }
    output += value[index]!;
    index++;
  }
  return output;
}

function decodeQuotedPrintable(value: string, maxBytes: number, budget?: Budget): Uint8Array {
  const output = new Uint8Array(Math.min(maxBytes, value.length));
  let written = 0;
  for (let index = 0; index < value.length && written < output.length; index++) {
    budget?.tick();
    if (value.charCodeAt(index) === 61) {
      if (value[index + 1] === '\r' && value[index + 2] === '\n') {
        index += 2;
        continue;
      }
      if (value[index + 1] === '\n') {
        index++;
        continue;
      }
      const high = value.charCodeAt(index + 1);
      const low = value.charCodeAt(index + 2);
      const hex = (code: number): number =>
        code >= 48 && code <= 57
          ? code - 48
          : code >= 65 && code <= 70
            ? code - 55
            : code >= 97 && code <= 102
              ? code - 87
              : -1;
      if (hex(high) >= 0 && hex(low) >= 0) {
        output[written++] = (hex(high) << 4) | hex(low);
        index += 2;
        continue;
      }
    }
    output[written++] = value.charCodeAt(index) & 0xff;
  }
  return output.slice(0, written);
}

function decodeBytes(bytes: Uint8Array, charset = 'utf-8'): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function splitParameters(value: string, budget?: Budget): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    budget?.tick();
    const char = value[index]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === ';' && !quoted) {
      if (parts.length < MAX_CONTENT_PARAMETERS) parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (parts.length < MAX_CONTENT_PARAMETERS) parts.push(value.slice(start).trim());
  return parts;
}

function unquote(value: string, budget?: Budget): string {
  const trimmed = value.trim();
  if (trimmed.length < 2 || trimmed[0] !== '"' || trimmed.at(-1) !== '"') return trimmed;
  let result = '';
  for (let index = 1; index < trimmed.length - 1; index++) {
    budget?.tick();
    if (trimmed[index] === '\\' && index + 1 < trimmed.length - 1) index++;
    result += trimmed[index]!;
  }
  return result;
}

function decodeExtended(value: string, budget?: Budget): string {
  const marker = value.indexOf("''");
  const charset = marker >= 0 ? value.slice(0, marker) : 'utf-8';
  const encoded = marker >= 0 ? value.slice(marker + 2) : value;
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index++) {
    budget?.tick();
    if (encoded[index] === '%' && index + 2 < encoded.length) {
      const parsed = Number.parseInt(encoded.slice(index + 1, index + 3), 16);
      if (Number.isFinite(parsed)) {
        bytes.push(parsed);
        index += 2;
        continue;
      }
    }
    const code = encoded.charCodeAt(index);
    if (code <= 0x7f) bytes.push(code);
    else bytes.push(0x3f);
  }
  return decodeBytes(new Uint8Array(bytes), charset);
}

function continuationParameter(
  name: string,
  budget?: Budget,
): { base: string; index: number; encoded: boolean } | undefined {
  let end = name.length;
  let encoded = false;
  if (name[end - 1] === '*') {
    encoded = true;
    end--;
  }
  let digitStart = end;
  while (digitStart > 0) {
    budget?.tick();
    const code = name.charCodeAt(digitStart - 1);
    if (code < 48 || code > 57) break;
    digitStart--;
  }
  if (digitStart === end || digitStart === 0 || name[digitStart - 1] !== '*') return undefined;
  const base = name.slice(0, digitStart - 1);
  if (base.length === 0) return undefined;
  let index = 0;
  for (let cursor = digitStart; cursor < end; cursor++) {
    budget?.tick();
    index = index * 10 + name.charCodeAt(cursor) - 48;
    if (!Number.isSafeInteger(index)) return undefined;
  }
  return { base, index, encoded };
}

function normalizeContentId(value: string | undefined, budget: Budget): string | undefined {
  if (value === undefined) return undefined;
  let start = 0;
  let end = value.length;
  if (value[start] === '<') start++;
  if (end > start && value[end - 1] === '>') end--;
  while (start < end && (value[start] === ' ' || value[start] === '\t')) {
    budget.tick();
    start++;
  }
  while (end > start && (value[end - 1] === ' ' || value[end - 1] === '\t')) {
    budget.tick();
    end--;
  }
  return value.slice(start, end);
}

export function parseContentType(value: string | undefined, budget?: Budget): MediaType {
  const parts = splitParameters(value ?? 'text/plain', budget);
  const parameters = new Map<string, string>();
  const continuations = new Map<string, Map<number, { value: string; encoded: boolean }>>();
  for (const part of parts.slice(1)) {
    budget?.tick();
    const equals = part.indexOf('=');
    if (equals <= 0) continue;
    const rawName = part.slice(0, equals).trim().toLowerCase();
    const rawValue = unquote(part.slice(equals + 1), budget);
    const continuation = continuationParameter(rawName, budget);
    if (continuation) {
      const base = continuation.base;
      const segments = continuations.get(base) ?? new Map<number, { value: string; encoded: boolean }>();
      segments.set(continuation.index, { value: rawValue, encoded: continuation.encoded });
      continuations.set(base, segments);
    } else if (rawName.endsWith('*')) {
      parameters.set(rawName.slice(0, -1), decodeExtended(rawValue, budget));
    } else parameters.set(rawName, rawValue);
  }
  for (const [base, segments] of continuations) {
    budget?.tick();
    let joined = '';
    let encoded = false;
    for (let index = 0; segments.has(index); index++) {
      budget?.tick();
      const segment = segments.get(index)!;
      joined += segment.value;
      encoded ||= segment.encoded;
    }
    parameters.set(base, encoded ? decodeExtended(joined, budget) : joined);
  }
  return { value: (parts[0] ?? 'text/plain').trim().toLowerCase(), parameters };
}

export function parseHeaders(source: string, budget?: Budget): Map<string, string> {
  if (source.length > MAX_HEADER_BYTES) {
    budget?.warnings.add({ code: 'UNREADABLE_PART', message: 'A MIME header exceeded the supported size.' });
    source = source.slice(0, MAX_HEADER_BYTES);
  }
  const headers = new Map<string, string>();
  let current = '';
  let value = '';
  let cursor = 0;
  let fieldsTruncated = false;
  const save = (): void => {
    if (current) {
      const previous = headers.get(current);
      const decoded = decodeEncodedWords(value.trim(), budget);
      if (previous !== undefined || headers.size < MAX_HEADER_FIELDS) {
        headers.set(current, previous === undefined ? decoded : `${previous}, ${decoded}`);
      } else fieldsTruncated = true;
    }
    current = '';
    value = '';
  };
  while (cursor <= source.length) {
    budget?.tick();
    const start = cursor;
    while (cursor < source.length && source[cursor] !== '\r' && source[cursor] !== '\n') {
      budget?.tick();
      cursor++;
    }
    const line = source.slice(start, cursor);
    if (source[cursor] === '\r' && source[cursor + 1] === '\n') cursor += 2;
    else if (cursor < source.length) cursor++;
    else cursor++;
    if (line === '') {
      save();
      break;
    }
    if ((line[0] === ' ' || line[0] === '\t') && current) value += ` ${line.trim()}`;
    else {
      save();
      const colon = line.indexOf(':');
      if (colon > 0) {
        current = line.slice(0, colon).trim().toLowerCase();
        value = line.slice(colon + 1).trim();
      } else {
        current = '';
        value = '';
      }
    }
  }
  if (cursor > source.length) save();
  if (fieldsTruncated)
    budget?.warnings.add({ code: 'UNREADABLE_PART', message: 'A MIME header contained too many fields.' });
  return headers;
}

function splitHeaderBody(
  bytes: Uint8Array,
  budget?: Budget,
): { header: string; body: Uint8Array; headerTooLarge: boolean } {
  const scanLimit = Math.min(bytes.length, MAX_HEADER_BYTES + 4);
  for (let index = 0; index < scanLimit; index++) {
    budget?.tick();
    if (index === 0 && bytes[index] === 10) {
      return {
        header: '',
        body: bytes.subarray(1),
        headerTooLarge: false,
      };
    }
    if (index === 1 && bytes[0] === 13 && bytes[index] === 10) {
      return {
        header: '',
        body: bytes.subarray(2),
        headerTooLarge: false,
      };
    }
    if (bytes[index] === 10 && index > 0 && bytes[index - 1] === 10) {
      if (index - 1 > MAX_HEADER_BYTES) break;
      return {
        header: new TextDecoder('utf-8').decode(bytes.subarray(0, index - 1)),
        body: bytes.subarray(index + 1),
        headerTooLarge: false,
      };
    }
    if (
      bytes[index] === 10 &&
      index > 2 &&
      bytes[index - 1] === 13 &&
      bytes[index - 2] === 10 &&
      bytes[index - 3] === 13
    ) {
      if (index - 3 > MAX_HEADER_BYTES) break;
      return {
        header: new TextDecoder('utf-8').decode(bytes.subarray(0, index - 3)),
        body: bytes.subarray(index + 1),
        headerTooLarge: false,
      };
    }
  }
  const tooLarge = bytes.length > MAX_HEADER_BYTES;
  return {
    header: new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, MAX_HEADER_BYTES))),
    body: new Uint8Array(),
    headerTooLarge: tooLarge,
  };
}

function boundarySlices(
  bytes: Uint8Array,
  boundary: string,
  budget: Budget,
): { parts: Uint8Array[]; closed: boolean; limited: boolean } {
  const delimiter = new TextEncoder().encode(`--${boundary}`);
  const parts: Uint8Array[] = [];
  let partStart = -1;
  let closed = false;
  let limited = false;
  for (let index = 0; index <= bytes.length - delimiter.length; index++) {
    budget.tick();
    if (index > 0 && bytes[index - 1] !== 10) continue;
    let matches = true;
    for (let offset = 0; offset < delimiter.length; offset++) {
      budget.tick();
      if (bytes[index + offset] !== delimiter[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    let end = index + delimiter.length;
    const closing = bytes[end] === 45 && bytes[end + 1] === 45;
    if (closing) end += 2;
    while (bytes[end] === 32 || bytes[end] === 9) {
      budget.tick();
      end++;
    }
    const atEof = end === bytes.length;
    if (bytes[end] !== 10 && !(bytes[end] === 13 && bytes[end + 1] === 10) && !(closing && atEof)) continue;
    if (partStart >= 0) {
      if (!budget.addEntries(1)) {
        limited = true;
        break;
      }
      let partEnd = index;
      if (partEnd > partStart && bytes[partEnd - 1] === 10) partEnd--;
      if (partEnd > partStart && bytes[partEnd - 1] === 13) partEnd--;
      parts.push(bytes.subarray(partStart, partEnd));
    }
    if (closing) {
      closed = true;
      break;
    }
    partStart = bytes[end] === 13 ? end + 2 : end + 1;
    index = partStart - 1;
  }
  if (!closed && !limited && partStart >= 0 && partStart < bytes.length) {
    if (budget.addEntries(1)) parts.push(bytes.subarray(partStart));
    else limited = true;
  }
  return { parts, closed, limited };
}

function validBoundary(value: string, budget: Budget): boolean {
  if (value.length === 0 || value.length > 70 || value[value.length - 1] === ' ') return false;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 32 || code > 126) return false;
  }
  return true;
}

export function decodeTransferEncoding(
  value: string,
  encoding: string | undefined,
  maxBytes: number,
  budget?: Budget,
): Uint8Array {
  const normalized = (encoding ?? '').trim().toLowerCase();
  if (normalized === 'base64') return decodeBase64(value, maxBytes, budget);
  if (normalized === 'quoted-printable') return decodeQuotedPrintable(value, maxBytes, budget);
  const bytes = new Uint8Array(Math.min(value.length, maxBytes));
  for (let index = 0; index < bytes.length; index++) {
    budget?.tick();
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function base64Digit(code: number): number {
  return code >= 65 && code <= 90
    ? code - 65
    : code >= 97 && code <= 122
      ? code - 71
      : code >= 48 && code <= 57
        ? code + 4
        : code === 43 || code === 45
          ? 62
          : code === 47 || code === 95
            ? 63
            : -1;
}

function expectedDecodedLength(bytes: Uint8Array, encoding: string | undefined, budget: Budget): number {
  const normalized = (encoding ?? '').trim().toLowerCase();
  if (normalized !== 'base64' && normalized !== 'quoted-printable') return bytes.length;
  let count = 0;
  if (normalized === 'base64') {
    let digits = 0;
    for (let index = 0; index < bytes.length; index++) {
      budget.tick();
      const code = bytes[index]!;
      if (code === 61) break;
      if (base64Digit(code) >= 0) digits++;
    }
    return Math.floor((digits * 6) / 8);
  }
  for (let index = 0; index < bytes.length; index++) {
    budget.tick();
    if (bytes[index] === 61) {
      if (bytes[index + 1] === 13 && bytes[index + 2] === 10) {
        index += 2;
        continue;
      }
      if (bytes[index + 1] === 10) {
        index++;
        continue;
      }
      if (index + 2 < bytes.length && hexDigit(bytes[index + 1]!) >= 0 && hexDigit(bytes[index + 2]!) >= 0) {
        count++;
        index += 2;
        continue;
      }
    }
    count++;
  }
  return count;
}

function hexDigit(code: number): number {
  return code >= 48 && code <= 57
    ? code - 48
    : code >= 65 && code <= 70
      ? code - 55
      : code >= 97 && code <= 102
        ? code - 87
        : -1;
}

/** Decode a MIME transfer body directly from bytes, allocating no more than its preflight cap. */
export function decodeTransferBytes(
  source: Uint8Array,
  encoding: string | undefined,
  maxBytes: number,
  budget: Budget,
): { bytes: Uint8Array; truncated: boolean } {
  const normalized = (encoding ?? '').trim().toLowerCase();
  const expected = expectedDecodedLength(source, normalized, budget);
  const withinBudget = budget.checkUncompressed(expected);
  const remaining = Math.max(0, budget.limits.totalUncompressedBytes - budget.totalUncompressedBytes);
  const capacity = Math.min(expected, maxBytes, withinBudget ? expected : remaining);
  if (normalized !== 'base64' && normalized !== 'quoted-printable') {
    const bytes = source.subarray(0, capacity);
    budget.addUncompressed(bytes.length);
    return { bytes, truncated: expected > capacity || !withinBudget };
  }
  const output = new Uint8Array(capacity);
  let written = 0;
  if (normalized === 'base64') {
    let bits = 0;
    let accumulator = 0;
    for (let index = 0; index < source.length && written < capacity; index++) {
      budget.tick();
      const code = source[index]!;
      if (code === 61) break;
      const digit = base64Digit(code);
      if (digit < 0) continue;
      accumulator = (accumulator << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        output[written++] = (accumulator >>> bits) & 0xff;
      }
    }
  } else {
    for (let index = 0; index < source.length && written < capacity; index++) {
      budget.tick();
      if (source[index] === 61) {
        if (source[index + 1] === 13 && source[index + 2] === 10) {
          index += 2;
          continue;
        }
        if (source[index + 1] === 10) {
          index++;
          continue;
        }
        if (
          index + 2 < source.length &&
          hexDigit(source[index + 1]!) >= 0 &&
          hexDigit(source[index + 2]!) >= 0
        ) {
          output[written++] = (hexDigit(source[index + 1]!) << 4) | hexDigit(source[index + 2]!);
          index += 2;
          continue;
        }
      }
      output[written++] = source[index]!;
    }
  }
  const bytes = output.subarray(0, written);
  budget.addUncompressed(bytes.length);
  return { bytes, truncated: expected > written || !withinBudget };
}

export function decodeMimeText(part: MimePart, budget?: Budget, maximumChars?: number): string {
  const bytes = part.bytes ?? new Uint8Array();
  const charset = part.contentType.parameters.get('charset') ?? 'utf-8';
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const maxChars = Math.max(0, maximumChars ?? Math.min(budget?.limits.outputChars ?? 1_000_000, 1_000_000));
  let result = '';
  let offset = 0;
  while (offset < bytes.length && result.length <= maxChars) {
    budget?.tick();
    const allowance = maxChars + 1 - result.length;
    const chunkSize = Math.max(1, Math.min(MIME_CHUNK_BYTES, allowance));
    const end = Math.min(bytes.length, offset + chunkSize);
    result += decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length });
    offset = end;
  }
  if (bytes.length === 0 || (offset === bytes.length && result.length <= maxChars))
    result += decoder.decode();
  return result.length > maxChars ? result.slice(0, maxChars) : result;
}

export function parseMime(bytes: Uint8Array, budget: Budget): MimeMessage {
  const root = splitHeaderBody(bytes, budget);
  const headers = parseHeaders(root.header, budget);
  const parts: MimePart[] = [];
  if (root.headerTooLarge) {
    budget.warnings.add({ code: 'UNREADABLE_PART', message: 'A MIME header exceeded the supported size.' });
    return { headers, parts, incomplete: true };
  }
  if (!budget.addEntries(1)) return { headers, parts, incomplete: true };
  interface Task {
    bytes: Uint8Array;
    target: MimePart[];
    exit?: boolean;
  }
  const pending: Task[] = [{ bytes, target: parts }];
  let incomplete = false;
  let activeDepths = 0;
  try {
    while (pending.length > 0) {
      budget.tick();
      const task = pending.pop()!;
      if (task.exit) {
        budget.exitDepth('xml');
        activeDepths--;
        continue;
      }
      const split = splitHeaderBody(task.bytes, budget);
      if (split.headerTooLarge) incomplete = true;
      const childHeaders = parseHeaders(split.header, budget);
      const contentType = parseContentType(childHeaders.get('content-type'), budget);
      const disposition = parseContentType(childHeaders.get('content-disposition') ?? 'inline', budget);
      const transferEncoding = childHeaders.get('content-transfer-encoding');
      const entity: MimePart = {
        headers: childHeaders,
        contentType,
        disposition,
        contentId: normalizeContentId(childHeaders.get('content-id'), budget),
        filename: disposition.parameters.get('filename') ?? contentType.parameters.get('name'),
        parts: [],
      };
      task.target.push(entity);
      if (split.headerTooLarge) continue;
      if (contentType.value.startsWith('multipart/')) {
        const boundary = contentType.parameters.get('boundary');
        if (!boundary || !validBoundary(boundary, budget)) {
          incomplete = true;
          continue;
        }
        let entered = false;
        try {
          entered = budget.enterDepth('xml');
        } catch (error) {
          budget.exitDepth('xml');
          throw error;
        }
        if (!entered) {
          budget.exitDepth('xml');
          incomplete = true;
          continue;
        }
        activeDepths++;
        const divided = boundarySlices(split.body, boundary, budget);
        if (!divided.closed || divided.limited) incomplete = true;
        pending.push({ bytes: new Uint8Array(), target: entity.parts, exit: true });
        for (let index = divided.parts.length - 1; index >= 0; index--) {
          budget.tick();
          pending.push({ bytes: divided.parts[index]!, target: entity.parts });
        }
      } else {
        const decoded = decodeTransferBytes(split.body, transferEncoding, split.body.length, budget);
        if (decoded.truncated) incomplete = true;
        const leaf: MimePart = { ...entity, bytes: decoded.bytes };
        task.target[task.target.length - 1] = leaf;
      }
    }
  } finally {
    while (activeDepths > 0) {
      budget.exitDepth('xml');
      activeDepths--;
    }
  }
  if (incomplete)
    budget.warnings.add({
      code: 'UNREADABLE_PART',
      message: 'A MIME part or multipart boundary was incomplete.',
    });
  return { headers, parts, incomplete };
}

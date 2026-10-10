import type { FormatId } from '../core/model.js';

const SAMPLE_CHARS = 8 * 1024;
const HTML_TAGS = ['html', 'head', 'body', 'title', 'meta', 'div', 'p', 'script', 'table', 'h1', 'h2'];
/** Header fields that mark an RFC 5322 message; two of them in a valid header block mean `eml`. */
const MESSAGE_HEADERS = new Set([
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'mime-version',
  'received',
  'return-path',
  'reply-to',
  'delivered-to',
  'content-type',
]);

/** Guess a text format from a bounded prefix without regex backtracking. */
export function detectTextKind(text: string): FormatId {
  return detectTextKindCandidates(text)[0] ?? 'txt';
}

/** Return equally plausible detected kinds in deterministic preference order. */
export function detectTextKindCandidates(text: string): readonly FormatId[] {
  const sample = text.slice(0, SAMPLE_CHARS);
  const start = skipWhitespace(sample, 0);
  if (start < sample.length && (sample[start] === '{' || sample[start] === '[') && isJson(sample, start)) {
    return ['json'];
  }
  if (isEmailHeaderBlock(sample)) return ['eml'];
  if (startsAsciiInsensitive(sample, start, '<!doctype html')) return ['html'];
  if (startsAsciiInsensitive(sample, start, '<?xml')) return ['xml'];
  if (hasKnownHtmlRoot(sample, start)) return ['html'];
  if (hasXmlRoot(sample, start)) return ['xml'];
  if (containsHtmlTag(sample)) return ['html'];
  const delimited = detectDelimitedKinds(sample);
  if (delimited.length > 0) return delimited;
  if (markdownScore(sample) >= 2) return ['markdown'];
  return ['txt'];
}

/**
 * True when the sample opens with RFC 5322 header fields (folded lines allowed) up to a blank line or the
 * sample end, and at least two of them are message headers. One linear pass, no regular expressions.
 */
function isEmailHeaderBlock(text: string): boolean {
  let messageHeaders = 0;
  let fields = 0;
  let at = 0;
  while (at < text.length) {
    let end = text.indexOf('\n', at);
    if (end < 0) end = text.length;
    const lineEnd = end > at && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
    if (lineEnd === at) break;
    const first = text.charCodeAt(at);
    if (first === 0x20 || first === 0x09) {
      if (fields === 0) return false;
    } else {
      let colon = at;
      while (colon < lineEnd && isFieldNameChar(text.charCodeAt(colon))) colon += 1;
      if (colon === at || colon >= lineEnd || text.charCodeAt(colon) !== 0x3a || colon - at > 76)
        return false;
      fields += 1;
      if (MESSAGE_HEADERS.has(text.slice(at, colon).toLowerCase())) messageHeaders += 1;
    }
    at = end + 1;
  }
  return messageHeaders >= 2;
}

/** RFC 5322 field-name characters: printable ASCII except colon. */
function isFieldNameChar(code: number): boolean {
  return code > 0x20 && code < 0x7f && code !== 0x3a;
}

function skipWhitespace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) i += 1;
  return i;
}

function isWhitespace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function startsAsciiInsensitive(text: string, at: number, prefix: string): boolean {
  if (text.length - at < prefix.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    const code = text.charCodeAt(at + i);
    const lower = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    if (lower !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

function containsHtmlTag(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 0x3c) continue;
    let nameStart = i + 1;
    if (text[nameStart] === '/') nameStart += 1;
    for (const tag of HTML_TAGS) {
      if (!startsAsciiInsensitive(text, nameStart, tag)) continue;
      const next = text.charCodeAt(nameStart + tag.length);
      if (next === 0x3e || next === 0x2f || isWhitespace(next)) return true;
    }
  }
  return false;
}

function hasKnownHtmlRoot(text: string, start: number): boolean {
  if (text.charCodeAt(start) !== 0x3c) return false;
  let nameStart = start + 1;
  if (text[nameStart] === '/') nameStart += 1;
  for (const tag of HTML_TAGS) {
    if (!startsAsciiInsensitive(text, nameStart, tag)) continue;
    const next = text.charCodeAt(nameStart + tag.length);
    if (next === 0x3e || next === 0x2f || isWhitespace(next)) return true;
  }
  return false;
}

function hasXmlRoot(text: string, start: number): boolean {
  let i = start;
  if (text[i] !== '<') return false;
  i += 1;
  if (text[i] === '?' || text[i] === '!' || text[i] === '/') return false;
  if (!isNameStart(text.charCodeAt(i))) return false;
  while (i < text.length && isNamePart(text.charCodeAt(i))) i += 1;
  while (i < text.length) {
    while (i < text.length && isWhitespace(text.charCodeAt(i))) i += 1;
    const next = text.charCodeAt(i);
    if (next === 0x3e) return true;
    if (next === 0x2f && text.charCodeAt(i + 1) === 0x3e) return true;
    if (!isNameStart(next)) return false;
    while (i < text.length && isNamePart(text.charCodeAt(i))) i += 1;
    while (i < text.length && isWhitespace(text.charCodeAt(i))) i += 1;
    if (text.charCodeAt(i) !== 0x3d) return false;
    i += 1;
    while (i < text.length && isWhitespace(text.charCodeAt(i))) i += 1;
    const quote = text.charCodeAt(i);
    if (quote !== 0x22 && quote !== 0x27) return false;
    i += 1;
    while (i < text.length && text.charCodeAt(i) !== quote) i += 1;
    if (i === text.length) return false;
    i += 1;
  }
  return false;
}

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x3a;
}

function isNamePart(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e;
}

function detectDelimitedKinds(text: string): FormatId[] {
  const candidates: FormatId[] = [];
  if (consistentRows(delimiterRows(text, 0x2c)) || consistentRows(delimiterRows(text, 0x3b)))
    candidates.push('csv');
  if (consistentRows(delimiterRows(text, 0x09))) candidates.push('tsv');
  return candidates;
}

function delimiterRows(text: string, delimiter: number): Array<{ count: number; nonEmpty: boolean }> {
  const rows: Array<{ count: number; nonEmpty: boolean }> = [];
  let count = 0;
  let quoted = false;
  let nonEmpty = false;
  const end = Math.min(text.length, SAMPLE_CHARS);
  for (let i = 0; i < end; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x22) {
      nonEmpty = true;
      if (quoted && text.charCodeAt(i + 1) === 0x22) i += 1;
      else quoted = !quoted;
    } else if (!quoted && code === delimiter) {
      count += 1;
      nonEmpty = true;
    } else if (!quoted && (code === 0x0a || code === 0x0d)) {
      rows.push({ count, nonEmpty });
      count = 0;
      nonEmpty = false;
      if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i += 1;
    } else if (!isWhitespace(code)) {
      nonEmpty = true;
    }
  }
  if (nonEmpty || count > 0) rows.push({ count, nonEmpty });
  return rows;
}

function consistentRows(rows: Array<{ count: number; nonEmpty: boolean }>): boolean {
  let expectedCount: number | undefined;
  let included = 0;
  for (const row of rows) {
    if (!row.nonEmpty) continue;
    if (expectedCount === undefined) {
      if (row.count === 0) return false;
      expectedCount = row.count;
    } else if (row.count !== expectedCount) return false;
    included += 1;
  }
  return expectedCount !== undefined && included >= 2;
}

function markdownScore(text: string): number {
  let score = 0;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i !== text.length && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d) continue;
    let first = lineStart;
    while (first < i && (text.charCodeAt(first) === 0x20 || text.charCodeAt(first) === 0x09)) first += 1;
    const marker = text.charCodeAt(first);
    if (marker === 0x23 && text.charCodeAt(first + 1) === 0x20) score += 2;
    if ((marker === 0x2d || marker === 0x2a || marker === 0x2b) && text.charCodeAt(first + 1) === 0x20)
      score += 1;
    if (marker === 0x60 && text.charCodeAt(first + 1) === 0x60 && text.charCodeAt(first + 2) === 0x60)
      score += 2;
    lineStart = i + 1;
  }
  let sawLinkLabel = false;
  for (let i = 0; i + 1 < text.length; i += 1) {
    if (text.charCodeAt(i) === 0x5b) sawLinkLabel = true;
    else if (sawLinkLabel && text.charCodeAt(i) === 0x5d && text.charCodeAt(i + 1) === 0x28) {
      score += 2;
      break;
    } else if (text.charCodeAt(i) === 0x0a) sawLinkLabel = false;
  }
  return score;
}

type JsonFrame = {
  kind: 'object' | 'array';
  state: 'key' | 'key-or-end' | 'colon' | 'value' | 'value-or-end' | 'comma-or-end';
};

function isJson(text: string, start: number): boolean {
  const stack: JsonFrame[] = [];
  let i = start;
  let rootComplete = false;
  const consumeValue = (): boolean => {
    i = skipWhitespace(text, i);
    const code = text.charCodeAt(i);
    if (code === 0x22) return consumeString();
    if (code === 0x7b || code === 0x5b) {
      stack.push({
        kind: code === 0x7b ? 'object' : 'array',
        state: code === 0x7b ? 'key-or-end' : 'value-or-end',
      });
      i += 1;
      return true;
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return true;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return true;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return true;
    }
    return consumeNumber();
  };
  const consumeString = (): boolean => {
    i += 1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        i += 1;
        return true;
      }
      if (code < 0x20) return false;
      if (code !== 0x5c) {
        i += 1;
        continue;
      }
      i += 1;
      const escaped = text.charCodeAt(i);
      if (escaped === 0x75) {
        for (let n = 1; n <= 4; n += 1) if (!isHex(text.charCodeAt(i + n))) return false;
        i += 5;
      } else if (
        escaped === 0x22 ||
        escaped === 0x5c ||
        escaped === 0x2f ||
        escaped === 0x62 ||
        escaped === 0x66 ||
        escaped === 0x6e ||
        escaped === 0x72 ||
        escaped === 0x74
      )
        i += 1;
      else return false;
    }
    return false;
  };
  const consumeNumber = (): boolean => {
    const begin = i;
    if (text.charCodeAt(i) === 0x2d) i += 1;
    if (text.charCodeAt(i) === 0x30) i += 1;
    else {
      if (!isDigitOneToNine(text.charCodeAt(i))) return false;
      while (isDigit(text.charCodeAt(i))) i += 1;
    }
    if (text.charCodeAt(i) === 0x2e) {
      i += 1;
      if (!isDigit(text.charCodeAt(i))) return false;
      while (isDigit(text.charCodeAt(i))) i += 1;
    }
    if (text.charCodeAt(i) === 0x65 || text.charCodeAt(i) === 0x45) {
      i += 1;
      if (text.charCodeAt(i) === 0x2b || text.charCodeAt(i) === 0x2d) i += 1;
      if (!isDigit(text.charCodeAt(i))) return false;
      while (isDigit(text.charCodeAt(i))) i += 1;
    }
    return i > begin;
  };

  if (!consumeValue()) return false;
  while (stack.length > 0) {
    i = skipWhitespace(text, i);
    const frame = stack[stack.length - 1];
    if (frame === undefined) return false;
    const code = text.charCodeAt(i);
    if (frame.state === 'key-or-end' || frame.state === 'key') {
      if (frame.state === 'key-or-end' && code === 0x7d) {
        stack.pop();
        i += 1;
      } else if (code === 0x22 && consumeString()) frame.state = 'colon';
      else return false;
    } else if (frame.state === 'colon') {
      if (code !== 0x3a) return false;
      frame.state = 'value';
      i += 1;
    } else if (frame.state === 'value-or-end' || frame.state === 'value') {
      if (frame.state === 'value-or-end' && code === 0x5d) {
        stack.pop();
        i += 1;
      } else {
        frame.state = 'comma-or-end';
        if (!consumeValue()) return false;
      }
    } else {
      if (frame.kind === 'object' && code === 0x7d) {
        stack.pop();
        i += 1;
      } else if (frame.kind === 'array' && code === 0x5d) {
        stack.pop();
        i += 1;
      } else if (code === 0x2c) {
        frame.state = frame.kind === 'object' ? 'key' : 'value';
        i += 1;
      } else return false;
    }
    if (stack.length === 0) rootComplete = true;
  }
  return rootComplete && skipWhitespace(text, i) === text.length;
}

function isHex(code: number): boolean {
  return isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}
function isDigitOneToNine(code: number): boolean {
  return code >= 0x31 && code <= 0x39;
}

import type { Budget } from '../core/budget.js';
import type { WarningSink } from '../core/warnings.js';

/** Shared limits and warnings for one XML part. */
export interface XmlContext {
  budget: Budget;
  warnings: WarningSink;
  path?: string;
}

/** Expanded element-name details, resolved using declarations in scope. */
export interface XmlElementInfo {
  name: string;
  localName: string;
  namespaceURI?: string;
}

export interface XmlHandler {
  onOpen?: (name: string, attrs: Map<string, string>, info: XmlElementInfo) => void;
  onText?: (text: string) => void;
  onClose?: (name: string, info: XmlElementInfo) => void;
}

interface ElementFrame {
  name: string;
  info: XmlElementInfo;
  namespaces: Map<string, string>;
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
type OncePerDocumentWarning = 'DTD_IGNORED' | 'UNKNOWN_ENTITY';
const documentWarnings = new WeakMap<Budget, Set<OncePerDocumentWarning>>();

function warn(ctx: XmlContext, code: string, message: string): void {
  ctx.warnings.add({ code, message, ...(ctx.path ? { loc: { path: ctx.path } } : {}) });
}

function warnOncePerDocument(ctx: XmlContext, code: OncePerDocumentWarning, message: string): void {
  let emitted = documentWarnings.get(ctx.budget);
  if (!emitted) {
    emitted = new Set();
    documentWarnings.set(ctx.budget, emitted);
  }
  if (emitted.has(code)) return;
  warn(ctx, code, message);
  emitted.add(code);
}

function equalsAsciiIgnoreCase(left: string, right: string, budget: Budget): boolean {
  if (left.length !== right.length) return false;
  let cursor = 0;
  while (cursor < left.length) {
    budget.tick();
    const code = left.charCodeAt(cursor);
    const folded = code >= 65 && code <= 90 ? code + 32 : code;
    const other = right.charCodeAt(cursor);
    const foldedOther = other >= 65 && other <= 90 ? other + 32 : other;
    if (folded !== foldedOther) return false;
    cursor += 1;
  }
  return true;
}

function declarationEncoding(text: string, budget: Budget): string | undefined {
  if (!text.startsWith('<?xml') || (!isSpace(text.charCodeAt(5)) && text.charCodeAt(5) !== 63))
    return undefined;
  let cursor = 5;
  let end = -1;
  while (cursor < text.length) {
    budget.tick();
    if (text.startsWith('?>', cursor)) {
      end = cursor;
      break;
    }
    cursor += 1;
  }
  if (end < 0) return undefined;
  cursor = 5;
  while (cursor < end) {
    while (cursor < end && isSpace(text.charCodeAt(cursor))) {
      budget.tick();
      cursor += 1;
    }
    const start = cursor;
    while (cursor < end && isNameChar(text.charCodeAt(cursor))) {
      budget.tick();
      cursor += 1;
    }
    if (start === cursor) {
      budget.tick();
      cursor += 1;
      continue;
    }
    const name = text.slice(start, cursor);
    while (cursor < end && isSpace(text.charCodeAt(cursor))) {
      budget.tick();
      cursor += 1;
    }
    if (text.charCodeAt(cursor) !== 61) continue;
    cursor += 1;
    while (cursor < end && isSpace(text.charCodeAt(cursor))) {
      budget.tick();
      cursor += 1;
    }
    const quote = text.charCodeAt(cursor);
    if (quote !== 34 && quote !== 39) continue;
    cursor += 1;
    const valueStart = cursor;
    while (cursor < end && text.charCodeAt(cursor) !== quote) {
      budget.tick();
      cursor += 1;
    }
    const value = text.slice(valueStart, cursor);
    if (!equalsAsciiIgnoreCase(name, 'encoding', budget)) {
      if (cursor < end) {
        budget.tick();
        cursor += 1;
      }
      continue;
    }
    if (cursor < end) {
      budget.tick();
    }
    return value;
  }
  return undefined;
}

function decodeInput(input: Uint8Array | string, ctx: XmlContext): string {
  if (typeof input === 'string') {
    const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const declared = declarationEncoding(text, ctx.budget);
    if (declared && !isSupportedEncoding(declared, ctx.budget)) {
      warn(ctx, 'ENCODING_GUESSED', 'Unsupported XML encoding; UTF-8 was used.');
    }
    return text;
  }

  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let offset = 0;
  if (input.length >= 2 && input[0] === 0xff && input[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (input.length >= 2 && input[0] === 0xfe && input[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  } else if (input.length >= 4 && input[0] === 0x00 && input[1] === 0x3c && input[2] === 0x00) {
    encoding = 'utf-16be';
  } else if (input.length >= 4 && input[0] === 0x3c && input[1] === 0x00 && input[3] === 0x00) {
    encoding = 'utf-16le';
  } else if (input.length >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    offset = 3;
  }

  let text = new TextDecoder(encoding).decode(input.subarray(offset));
  const declared = declarationEncoding(text, ctx.budget);
  if (declared) {
    if (!isSupportedEncoding(declared, ctx.budget)) {
      warn(ctx, 'ENCODING_GUESSED', 'Unsupported XML encoding; UTF-8 was used.');
      if (encoding !== 'utf-8') text = new TextDecoder('utf-8').decode(input.subarray(offset));
    }
  }
  return text;
}

function isSupportedEncoding(encoding: string, budget: Budget): boolean {
  return (
    equalsAsciiIgnoreCase(encoding, 'UTF-8', budget) ||
    equalsAsciiIgnoreCase(encoding, 'UTF-16', budget) ||
    equalsAsciiIgnoreCase(encoding, 'UTF-16LE', budget) ||
    equalsAsciiIgnoreCase(encoding, 'UTF-16BE', budget)
  );
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function isNameChar(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code === 58 ||
    code === 45 ||
    code === 46 ||
    code >= 0x80
  );
}

function isHex(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 70) return code - 55;
  if (code >= 97 && code <= 102) return code - 87;
  return -1;
}

function isDigit(code: number): number {
  return code >= 48 && code <= 57 ? code - 48 : -1;
}

function isXmlCodePoint(code: number): boolean {
  return (
    code === 9 ||
    code === 10 ||
    code === 13 ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

interface NumericEntityResult {
  value: string;
  valid: boolean;
}

function numericEntity(value: string, budget: Budget): NumericEntityResult | undefined {
  if (value.length < 2 || value.charCodeAt(0) !== 35) return undefined;
  let radix = 10;
  let cursor = 1;
  if (value.charCodeAt(cursor) === 120 || value.charCodeAt(cursor) === 88) {
    radix = 16;
    cursor += 1;
  }
  if (cursor === value.length) return { value: '\ufffd', valid: false };
  let code = 0;
  while (cursor < value.length) {
    budget.tick();
    const digit = radix === 16 ? isHex(value.charCodeAt(cursor)) : isDigit(value.charCodeAt(cursor));
    if (digit < 0) return { value: '\ufffd', valid: false };
    code = code * radix + digit;
    if (code > 0x10ffff) return { value: '\ufffd', valid: false };
    cursor += 1;
  }
  if (!isXmlCodePoint(code)) return { value: '\ufffd', valid: false };
  return { value: String.fromCodePoint(code), valid: true };
}

function decodeEntities(
  value: string,
  ctx: XmlContext,
  state: { unknownEntity: boolean; malformed: boolean },
): string {
  // Most text and attribute values hold no reference at all (#182).
  if (value.indexOf('&') < 0) return value;
  const pieces: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    ctx.budget.tick();
    if (value.charCodeAt(cursor) !== 38) {
      const start = cursor;
      while (cursor < value.length && value.charCodeAt(cursor) !== 38) {
        ctx.budget.tick();
        cursor += 1;
      }
      pieces.push(value.slice(start, cursor));
      continue;
    }
    const start = cursor;
    cursor += 1;
    const entityStart = cursor;
    while (
      cursor < value.length &&
      value.charCodeAt(cursor) !== 59 &&
      !isSpace(value.charCodeAt(cursor)) &&
      value.charCodeAt(cursor) !== 60
    ) {
      ctx.budget.tick();
      cursor += 1;
    }
    if (cursor >= value.length || value.charCodeAt(cursor) !== 59) {
      state.unknownEntity = true;
      pieces.push(value.slice(start, cursor));
      continue;
    }
    const entity = value.slice(entityStart, cursor);
    cursor += 1;
    if (entity === 'lt') pieces.push('<');
    else if (entity === 'gt') pieces.push('>');
    else if (entity === 'amp') pieces.push('&');
    else if (entity === 'quot') pieces.push('"');
    else if (entity === 'apos') pieces.push("'");
    else if (entity.charCodeAt(0) === 35) {
      const decoded = numericEntity(entity, ctx.budget);
      if (!decoded?.valid) state.malformed = true;
      pieces.push(decoded?.value ?? '\ufffd');
    } else {
      state.unknownEntity = true;
      pieces.push(value.slice(start, cursor));
    }
  }
  return pieces.join('');
}

/** Scan XML using a bounded hand-written scanner. DTDs and PIs are only skipped. */
/** The namespace map of an element that declares none. Never written to. */
const NO_NAMESPACES: Map<string, string> = new Map();

export function scanXml(input: Uint8Array | string, handler: XmlHandler, ctx: XmlContext): void {
  const text = decodeInput(input, ctx);
  const frames: ElementFrame[] = [];
  const entityState = { unknownEntity: false, malformed: false };
  let cursor = 0;
  let stopped = false;
  let textChars = 0;
  let malformedWarned = false;

  const consume = (): string => {
    ctx.budget.tick();
    const value = text.charAt(cursor);
    cursor += 1;
    return value;
  };
  // The hot scans move the cursor directly and tick once per scan, not once per character (#182).
  const skipSpace = (): void => {
    ctx.budget.tick();
    while (cursor < text.length && isSpace(text.charCodeAt(cursor))) cursor += 1;
  };
  const readName = (): string => {
    ctx.budget.tick();
    const start = cursor;
    while (cursor < text.length && isNameChar(text.charCodeAt(cursor))) cursor += 1;
    return text.slice(start, cursor);
  };
  /** Move to the next `char` (or the end) with one native search. */
  const skipTo = (char: string): void => {
    ctx.budget.tick();
    const found = text.indexOf(char, cursor);
    cursor = found < 0 ? text.length : found;
  };
  const emitText = (raw: string): boolean => {
    if (raw.length === 0) return true;
    const decoded = decodeEntities(raw, ctx, entityState);
    if (decoded.length === 0) return true;
    const nextTextChars = textChars + decoded.length;
    if (!ctx.budget.checkOutputChars(nextTextChars)) return false;
    textChars = nextTextChars;
    handler.onText?.(decoded);
    return true;
  };
  const closeTop = (): void => {
    ctx.budget.tick();
    const frame = frames.pop();
    if (!frame) return;
    try {
      handler.onClose?.(frame.name, frame.info);
    } finally {
      ctx.budget.exitDepth('xml');
    }
  };
  const reportStateWarnings = (): void => {
    if (entityState.unknownEntity) {
      warnOncePerDocument(ctx, 'UNKNOWN_ENTITY', 'XML contained an entity reference that was not expanded.');
    }
    if (entityState.malformed && !malformedWarned) {
      warn(ctx, 'UNREADABLE_PART', 'Malformed XML character reference was replaced.');
      malformedWarned = true;
    }
  };
  const skipUntil = (terminator: string): boolean => {
    while (cursor < text.length) {
      ctx.budget.tick();
      if (text.startsWith(terminator, cursor)) {
        cursor += terminator.length;
        return true;
      }
      consume();
    }
    return false;
  };
  const skipDoctype = (): boolean => {
    cursor += 9;
    let brackets = 0;
    let quote = 0;
    while (cursor < text.length) {
      ctx.budget.tick();
      if (quote !== 0) {
        if (text.charCodeAt(cursor) === quote) quote = 0;
        consume();
        continue;
      }
      if (text.startsWith('<!--', cursor)) {
        cursor += 4;
        if (!skipUntil('-->')) return false;
        continue;
      }
      const code = text.charCodeAt(cursor);
      if (code === 34 || code === 39) quote = code;
      else if (code === 91) brackets += 1;
      else if (code === 93 && brackets > 0) brackets -= 1;
      else if (code === 62 && brackets === 0) {
        cursor += 1;
        return true;
      }
      consume();
    }
    return false;
  };
  const baseNamespaces = new Map<string, string>([['xml', XML_NAMESPACE]]);
  const malformed = (): void => {
    entityState.malformed = true;
  };

  try {
    while (cursor < text.length && !stopped) {
      ctx.budget.tick();
      if (text.charCodeAt(cursor) !== 60) {
        const start = cursor;
        skipTo('<');
        if (!emitText(text.slice(start, cursor))) stopped = true;
        reportStateWarnings();
        continue;
      }

      if (text.startsWith('<!--', cursor)) {
        cursor += 4;
        if (!skipUntil('-->')) malformed();
        continue;
      }
      if (text.startsWith('<![CDATA[', cursor)) {
        cursor += 9;
        const start = cursor;
        while (cursor < text.length && !text.startsWith(']]>', cursor)) consume();
        const raw = text.slice(start, cursor);
        if (cursor < text.length) cursor += 3;
        else malformed();
        const nextTextChars = textChars + raw.length;
        if (!ctx.budget.checkOutputChars(nextTextChars)) stopped = true;
        else {
          textChars = nextTextChars;
          if (raw.length > 0) handler.onText?.(raw);
        }
        reportStateWarnings();
        continue;
      }
      if (text.startsWith('<!DOCTYPE', cursor)) {
        warnOncePerDocument(ctx, 'DTD_IGNORED', 'XML document type declarations are ignored.');
        if (!skipDoctype()) malformed();
        continue;
      }
      if (text.startsWith('<?', cursor)) {
        cursor += 2;
        if (!skipUntil('?>')) malformed();
        continue;
      }
      if (text.startsWith('</', cursor)) {
        cursor += 2;
        skipSpace();
        const name = readName();
        skipSpace();
        if (text.charCodeAt(cursor) === 62) cursor += 1;
        else {
          while (cursor < text.length && text.charCodeAt(cursor) !== 62) consume();
          if (cursor < text.length) cursor += 1;
          malformed();
        }
        let match = frames.length - 1;
        while (match >= 0 && frames[match]?.name !== name) {
          ctx.budget.tick();
          match -= 1;
        }
        if (match < 0) malformed();
        else {
          if (match !== frames.length - 1) malformed();
          while (frames.length > match) closeTop();
        }
        reportStateWarnings();
        continue;
      }
      if (text.startsWith('<!', cursor)) {
        cursor += 2;
        while (cursor < text.length && text.charCodeAt(cursor) !== 62) consume();
        if (cursor < text.length) cursor += 1;
        malformed();
        continue;
      }

      cursor += 1;
      const name = readName();
      if (name.length === 0) {
        malformed();
        if (cursor < text.length) consume();
        reportStateWarnings();
        continue;
      }
      const attrs = new Map<string, string>();
      let selfClosing = false;
      let tagFinished = false;
      while (cursor < text.length && !tagFinished) {
        skipSpace();
        if (text.startsWith('/>', cursor)) {
          cursor += 2;
          selfClosing = true;
          tagFinished = true;
          continue;
        }
        if (text.charCodeAt(cursor) === 62) {
          cursor += 1;
          tagFinished = true;
          continue;
        }
        const attrName = readName();
        if (attrName.length === 0) {
          malformed();
          consume();
          continue;
        }
        skipSpace();
        if (text.charCodeAt(cursor) !== 61) {
          attrs.set(attrName, '');
          malformed();
          continue;
        }
        consume();
        skipSpace();
        const quote = text.charCodeAt(cursor);
        let rawValue = '';
        if (quote === 34 || quote === 39) {
          consume();
          const valueStart = cursor;
          skipTo(quote === 34 ? '"' : "'");
          rawValue = text.slice(valueStart, cursor);
          if (cursor < text.length) consume();
          else malformed();
        } else {
          const valueStart = cursor;
          while (cursor < text.length && !isSpace(text.charCodeAt(cursor)) && text.charCodeAt(cursor) !== 62)
            consume();
          rawValue = text.slice(valueStart, cursor);
          malformed();
        }
        if (attrs.has(attrName)) malformed();
        attrs.set(attrName, decodeEntities(rawValue, ctx, entityState));
      }
      if (!tagFinished) malformed();
      reportStateWarnings();

      // Most elements declare no namespace and share one empty map.
      let namespaces = NO_NAMESPACES;
      for (const [attrName, value] of attrs) {
        ctx.budget.tick();
        if (attrName !== 'xmlns' && !attrName.startsWith('xmlns:')) continue;
        if (namespaces === NO_NAMESPACES) namespaces = new Map<string, string>();
        namespaces.set(attrName === 'xmlns' ? '' : attrName.slice(6), value);
      }
      const colon = name.indexOf(':');
      const prefix = colon < 0 ? '' : name.slice(0, colon);
      const localName = colon < 0 ? name : name.slice(colon + 1);
      let namespaceURI = namespaces.get(prefix);
      if (namespaceURI === undefined) {
        let frameIndex = frames.length - 1;
        while (frameIndex >= 0) {
          ctx.budget.tick();
          const parentNamespaces = frames[frameIndex]?.namespaces;
          if (parentNamespaces?.has(prefix)) {
            namespaceURI = parentNamespaces.get(prefix);
            break;
          }
          frameIndex -= 1;
        }
        if (namespaceURI === undefined) namespaceURI = baseNamespaces.get(prefix);
      }
      const info: XmlElementInfo = { name, localName, namespaceURI: namespaceURI || undefined };
      let withinDepth: boolean;
      try {
        withinDepth = ctx.budget.enterDepth('xml');
      } catch (error) {
        ctx.budget.exitDepth('xml');
        throw error;
      }
      if (!withinDepth) {
        ctx.budget.exitDepth('xml');
        stopped = true;
        continue;
      }
      frames.push({ name, info, namespaces });
      handler.onOpen?.(name, attrs, info);
      if (selfClosing) closeTop();
    }

    reportStateWarnings();
    if (!stopped && frames.length > 0) {
      if (!malformedWarned) warn(ctx, 'UNREADABLE_PART', 'XML ended before all elements were closed.');
      while (frames.length > 0) closeTop();
    } else if (stopped) {
      while (frames.length > 0) closeTop();
    }
  } finally {
    while (frames.length > 0) {
      try {
        ctx.budget.tick();
      } catch {
        // Preserve the active parse error while balancing every entered depth.
      }
      frames.pop();
      ctx.budget.exitDepth('xml');
    }
  }
  reportStateWarnings();
}

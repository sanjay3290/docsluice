import type { Metadata } from '../core/model.js';
import type { XmlContext } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import type { XmlElement } from '../xml/index.js';
import {
  DUBLIN_CORE_NS,
  ODF_META_NS,
  ODF_OFFICE_NS,
  odfAttribute,
  odfElements,
  odfText,
  odfWarn,
  type OdfElement,
} from './common.js';

export interface OdfMetadataOptions {
  /** Keep personal authors and custom properties. Defaults to true. */
  metadata?: boolean;
}

/**
 * Parse direct metadata fields from `office:meta` beneath an ODF `office:document-meta`
 * package part or flat `office:document` root into the existing metadata shape.
 */
export function parseOdfMetadata(
  input: Uint8Array | string,
  ctx: XmlContext,
  options: OdfMetadataOptions = {},
): Metadata {
  const root = parseXml(input, ctx);
  const result: Metadata = {};
  if (!root) return result;
  if (
    root.namespaceURI !== ODF_OFFICE_NS ||
    (root.localName !== 'document-meta' && root.localName !== 'document')
  ) {
    odfWarn(ctx, 'UNREADABLE_PART', 'ODF metadata has an invalid document root.');
    return result;
  }
  let metadataElement: XmlElement | undefined;
  for (const child of root.children) {
    ctx.budget.tick();
    if (typeof child !== 'string' && child.namespaceURI === ODF_OFFICE_NS && child.localName === 'meta') {
      metadataElement = child;
      break;
    }
  }
  if (!metadataElement) return result;
  const includePersonal = options.metadata !== false;
  const elements = odfElements(root, ctx.budget);
  const scopeByElement = new Map<XmlElement, OdfElement>();
  for (const item of elements) {
    ctx.budget.tick();
    scopeByElement.set(item.element, item);
  }
  for (const child of metadataElement.children) {
    ctx.budget.tick();
    if (typeof child === 'string') continue;
    const item = scopeByElement.get(child);
    if (!item) continue;
    const { element } = item;
    if (element.namespaceURI === DUBLIN_CORE_NS) {
      if (element.localName === 'creator') {
        if (includePersonal) {
          const author = odfText(element, ctx.budget);
          if (author.length > 0) (result.authors ??= []).push(author);
        }
        continue;
      }
      const text = odfText(element, ctx.budget);
      if (element.localName === 'title' && text.length > 0 && result.title === undefined) {
        result.title = text;
      } else if (element.localName === 'language' && text.length > 0 && result.language === undefined) {
        result.language = text;
      } else if (element.localName === 'date' && result.modified === undefined) {
        const date = validIsoDate(text, ctx);
        if (date) result.modified = date;
      }
    } else if (element.namespaceURI === ODF_META_NS) {
      if (element.localName === 'initial-creator' && includePersonal) {
        const author = odfText(element, ctx.budget);
        if (author.length > 0) (result.authors ??= []).push(author);
      } else if (element.localName === 'creation-date' && result.created === undefined) {
        const date = validIsoDate(odfText(element, ctx.budget), ctx);
        if (date) result.created = date;
      } else if (element.localName === 'document-statistic' && result.pageCount === undefined) {
        const raw = odfAttribute(item, ODF_META_NS, 'page-count', ctx.budget);
        const count = raw === undefined ? undefined : validCount(raw, ctx);
        if (count !== undefined) result.pageCount = count;
      } else if (element.localName === 'user-defined' && includePersonal) {
        const name = odfAttribute(item, ODF_META_NS, 'name', ctx.budget);
        const value = odfText(element, ctx.budget);
        if (name !== undefined && name.length > 0) (result.custom ??= []).push({ name, value });
        else odfWarn(ctx, 'UNREADABLE_PART', 'ODF custom metadata is missing a property name.');
      }
    }
  }
  return result;
}

function validCount(value: string, ctx: XmlContext): number | undefined {
  if (value.length === 0) return undefined;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    count = count * 10 + code - 48;
    if (!Number.isSafeInteger(count)) return undefined;
  }
  return count;
}

function validIsoDate(value: string, ctx: XmlContext): string | undefined {
  if (value.length < 10 || value.length > 64) return undefined;
  const year = readDigits(value, 0, 4, ctx);
  const month = readDigits(value, 5, 2, ctx);
  const day = readDigits(value, 8, 2, ctx);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (value.charCodeAt(4) !== 45 || value.charCodeAt(7) !== 45 || month < 1 || month > 12) return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > monthDays[month - 1]!) return undefined;
  if (value.length > 10 && value.charCodeAt(10) !== 84) return undefined;
  let hasZone = false;
  for (let index = 11; index < value.length; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code === 90 || code === 122 || code === 43 || code === 45) {
      hasZone = true;
      break;
    }
  }
  // ECMAScript defines only three fraction digits; LibreOffice writes nine. Trim or pad to three so
  // every engine parses the same string.
  let normalized = value;
  if (value.length > 20 && value.charCodeAt(19) === 46) {
    let end = 20;
    while (end < value.length && value.charCodeAt(end) >= 48 && value.charCodeAt(end) <= 57) {
      ctx.budget.tick();
      end += 1;
    }
    normalized = `${value.slice(0, 20)}${value.slice(20, Math.min(end, 23)).padEnd(3, '0')}${value.slice(end)}`;
  }
  const timestamp = Date.parse(normalized.length > 10 && !hasZone ? `${normalized}Z` : normalized);
  if (!Number.isFinite(timestamp)) return undefined;
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return undefined;
  }
}

function readDigits(value: string, start: number, count: number, ctx: XmlContext): number | undefined {
  let result = 0;
  for (let index = start; index < start + count; index += 1) {
    ctx.budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result;
}

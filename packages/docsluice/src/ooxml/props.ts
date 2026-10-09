import type { Metadata } from '../core/model.js';
import type { XmlContext } from '../xml/index.js';
import { parseXml } from '../xml/index.js';
import type { XmlElement } from '../xml/index.js';
import type { OoxmlParts } from './parts.js';

const CORE = 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties';
const DC = 'http://purl.org/dc/elements/1.1/';
const TERMS = 'http://purl.org/dc/terms/';
const APP = 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties';
const CUSTOM = 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties';
const VT = 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes';
const VT_SCALARS = new Set([
  'lpstr',
  'lpwstr',
  'bstr',
  'i1',
  'i2',
  'i4',
  'i8',
  'int',
  'ui1',
  'ui2',
  'ui4',
  'ui8',
  'uint',
  'r4',
  'r8',
  'decimal',
  'date',
  'filetime',
  'bool',
  'error',
  'empty',
  'null',
]);

function warn(ctx: XmlContext): void {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'OOXML document properties could not be read.' });
}

function directElements(element: XmlElement, ctx: XmlContext): XmlElement[] {
  const found: XmlElement[] = [];
  for (const child of element.children) {
    ctx.budget.tick();
    if (typeof child !== 'string') found.push(child);
  }
  return found;
}

/** Read scalar text only; nested markup is malformed for these property values. */
function scalarText(element: XmlElement, ctx: XmlContext): string | undefined {
  const chunks: string[] = [];
  let nested = false;
  for (const child of element.children) {
    ctx.budget.tick();
    if (typeof child === 'string') chunks.push(child);
    else nested = true;
  }
  if (nested) {
    warn(ctx);
    return undefined;
  }
  return chunks.join('').trim();
}

function customValue(element: XmlElement, ctx: XmlContext): string | undefined {
  if (element.namespaceURI !== VT) {
    warn(ctx);
    return undefined;
  }
  if (VT_SCALARS.has(element.localName)) return scalarText(element, ctx);
  if (element.localName !== 'vector') {
    warn(ctx);
    return undefined;
  }

  const baseType = element.attrs.get('baseType');
  const sizeText = element.attrs.get('size');
  const size = sizeText && /^\d+$/.test(sizeText) ? Number(sizeText) : Number.NaN;
  if (!baseType || !Number.isSafeInteger(size) || size < 0) {
    warn(ctx);
    return undefined;
  }
  const items = directElements(element, ctx);
  if (items.length !== size) {
    warn(ctx);
    return undefined;
  }
  const values: string[] = [];
  for (const item of items) {
    ctx.budget.tick();
    let scalar = item;
    if (baseType === 'variant' && item.localName === 'variant' && item.namespaceURI === VT) {
      const variantChildren = directElements(item, ctx);
      if (variantChildren.length !== 1) {
        warn(ctx);
        return undefined;
      }
      scalar = variantChildren[0]!;
    } else if (item.localName !== baseType) {
      warn(ctx);
      return undefined;
    }
    if (scalar.namespaceURI !== VT || !VT_SCALARS.has(scalar.localName)) {
      warn(ctx);
      return undefined;
    }
    const value = scalarText(scalar, ctx);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values.join(', ');
}

function normalizedDate(value: string, ctx: XmlContext): string | undefined {
  for (let index = 0; index < value.length; index += 1) ctx.budget.tick();
  const match = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-](\d\d):(\d\d))?)?$/.exec(
    value,
  );
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) return undefined;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59))
    return undefined;
  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) return undefined;
  // A date without an explicit zone must not depend on the runtime's local timezone.
  const hasZone = /(?:Z|[+-]\d\d:\d\d)$/.test(value);
  const time = Date.parse(match[4] !== undefined && !hasZone ? `${value}Z` : value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

export async function readProperties(
  parts: OoxmlParts,
  ctx: XmlContext,
  includePersonal = true,
): Promise<Metadata> {
  const metadata: Metadata = {};
  const read = async (path: string): Promise<XmlElement | undefined> => {
    const bytes = await parts.read(path);
    if (!bytes) return undefined;
    const root = parseXml(bytes, ctx);
    const expected = path.endsWith('core.xml') ? CORE : path.endsWith('app.xml') ? APP : CUSTOM;
    if (
      !root ||
      root.namespaceURI !== expected ||
      (root.localName !== 'Properties' && expected !== CORE) ||
      (root.localName !== 'coreProperties' && expected === CORE)
    ) {
      warn(ctx);
      return undefined;
    }
    return root;
  };
  const core = await read('docProps/core.xml');
  if (core) {
    for (const node of directElements(core, ctx)) {
      ctx.budget.tick();
      const isTitle = node.namespaceURI === DC && node.localName === 'title';
      const isCreator = node.namespaceURI === DC && node.localName === 'creator';
      const isLastModifiedBy = node.namespaceURI === CORE && node.localName === 'lastModifiedBy';
      const isCreated = node.namespaceURI === TERMS && node.localName === 'created';
      const isModified = node.namespaceURI === TERMS && node.localName === 'modified';
      const isLanguage = node.namespaceURI === DC && node.localName === 'language';
      if (!isTitle && !isCreator && !isLastModifiedBy && !isCreated && !isModified && !isLanguage) continue;
      const value = scalarText(node, ctx);
      if (value === undefined) continue;
      if (!value) continue;
      if (isTitle) metadata.title = value;
      if (includePersonal && isCreator) {
        metadata.authors = [...(metadata.authors ?? []), value];
      }
      if (includePersonal && isLastModifiedBy) {
        metadata.authors = [...(metadata.authors ?? []), value];
      }
      if (isCreated) {
        const date = normalizedDate(value, ctx);
        if (date) metadata.created = date;
        else warn(ctx);
      }
      if (isModified) {
        const date = normalizedDate(value, ctx);
        if (date) metadata.modified = date;
        else warn(ctx);
      }
      if (isLanguage) metadata.language = value;
    }
  }

  const app = await read('docProps/app.xml');
  if (app)
    for (const node of directElements(app, ctx)) {
      ctx.budget.tick();
      if (node.namespaceURI !== APP || (node.localName !== 'Pages' && node.localName !== 'Slides')) continue;
      const value = scalarText(node, ctx);
      if (value === undefined) continue;
      if (!/^\d+$/.test(value)) {
        warn(ctx);
        continue;
      }
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        warn(ctx);
        continue;
      }
      if (metadata.pageCount === undefined || node.localName === 'Pages') metadata.pageCount = count;
    }

  if (includePersonal) {
    const custom = await read('docProps/custom.xml');
    if (custom) {
      const pairs: Array<{ name: string; value: string }> = [];
      const seenNames = new Set<string>();
      const duplicateNames = new Set<string>();
      for (const node of directElements(custom, ctx)) {
        ctx.budget.tick();
        if (node.namespaceURI !== CUSTOM || node.localName !== 'property') continue;
        const name = node.attrs.get('name');
        if (!name) {
          warn(ctx);
          continue;
        }
        if (seenNames.has(name)) {
          duplicateNames.add(name);
          warn(ctx);
          continue;
        }
        seenNames.add(name);
        const values = directElements(node, ctx);
        const valueNode = values.length === 1 ? values[0] : undefined;
        if (!valueNode) {
          warn(ctx);
          continue;
        }
        const value = customValue(valueNode, ctx);
        if (value === undefined) continue;
        pairs.push({ name, value });
      }
      const safePairs = pairs.filter((pair) => {
        ctx.budget.tick();
        return !duplicateNames.has(pair.name);
      });
      if (safePairs.length) metadata.custom = safePairs;
    }
  }
  return metadata;
}

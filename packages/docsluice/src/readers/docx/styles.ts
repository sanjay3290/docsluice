import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** Resolved paragraph style information used by the DOCX body scanner. */
export interface DocxStyle {
  id: string;
  name?: string;
  basedOn?: string;
  /** Heading level, when this style or an ancestor identifies one. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** List numbering from `w:numPr`, inherited through `basedOn` (DOC-3). */
  numId?: string;
  ilvl?: number;
}

interface MutableStyle {
  id: string;
  name?: string;
  basedOn?: string;
  outlineLevel?: number;
  builtinLevel?: HeadingLevel;
  numId?: string;
  ilvl?: number;
}

interface Frame {
  namespaceURI?: string;
  localName: string;
  declaredStyle?: MutableStyle;
  styleRecord?: MutableStyle;
  isStyleRoot: boolean;
  isStyleParagraphProperties: boolean;
  isStyleNumberingProperties: boolean;
  inParagraphProperties: boolean;
}

const warnUnreadable = (ctx: XmlContext): void => {
  ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The Word styles part could not be read.' });
};

function attribute(
  attrs: Map<string, string>,
  local: string,
  scopes: readonly Map<string, string>[],
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    const prefix = colon < 0 ? '' : qualifiedName.slice(0, colon);
    const attrLocal = colon < 0 ? qualifiedName : qualifiedName.slice(colon + 1);
    if (attrLocal !== local) continue;
    if (prefix.length === 0) continue;
    for (let index = scopes.length - 1; index >= 0; index--) {
      budget.tick();
      const scope = scopes[index]!;
      if (scope.has(prefix)) {
        if (scope.get(prefix) === WORD_NS) return value;
        break;
      }
    }
  }
  return undefined;
}

function headingFromName(value: string | undefined, id: string): HeadingLevel | undefined {
  if (id.toLowerCase() === 'title' || value?.toLowerCase() === 'title') return 1;
  const normalizedId = id.toLowerCase();
  const normalizedName = value?.trim().toLowerCase();
  for (let level = 1; level <= 6; level++) {
    if (normalizedId === `heading${level}` || normalizedName === `heading ${level}`)
      return level as HeadingLevel;
  }
  return undefined;
}

function parseSmallInteger(value: string, budget: XmlContext['budget']): number | undefined {
  if (value.length === 0 || value.length > 2) return undefined;
  let number = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    number = number * 10 + code - 48;
  }
  return number;
}

/**
 * Parse styles.xml with bounded SAX events. `basedOn` links are resolved iteratively,
 * with a visited set so hostile cycles cannot recurse or loop forever.
 */
export function parseDocxStyles(input: Uint8Array | string, ctx: XmlContext): Map<string, DocxStyle> {
  const raw = new Map<string, MutableStyle>();
  const frames: Frame[] = [];
  const scopes: Map<string, string>[] = [];
  let rootSeen = false;
  let validRoot = false;
  let duplicateWarned = false;

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        if (frames.length === 0 && !rootSeen) {
          rootSeen = true;
          validRoot = info.namespaceURI === WORD_NS && info.localName === 'styles';
          if (!validRoot) warnUnreadable(ctx);
        }
        const scope = new Map<string, string>();
        for (const [key, value] of attrs) {
          ctx.budget.tick();
          if (key === 'xmlns') scope.set('', value);
          else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
        }
        scopes.push(scope);
        const parent = frames.at(-1);
        const styleRoot =
          validRoot &&
          frames.length === 1 &&
          parent?.namespaceURI === WORD_NS &&
          parent.localName === 'styles' &&
          info.namespaceURI === WORD_NS &&
          info.localName === 'style';
        let declaredStyle: MutableStyle | undefined;
        if (styleRoot) {
          const id = attribute(attrs, 'styleId', scopes, ctx.budget);
          if (id !== undefined) {
            declaredStyle = { id };
            const kind = attribute(attrs, 'type', scopes, ctx.budget);
            if (kind !== 'paragraph') declaredStyle = undefined;
          }
        }
        const styleRecord = declaredStyle ?? parent?.styleRecord;
        const paragraphProperties =
          info.namespaceURI === WORD_NS &&
          info.localName === 'pPr' &&
          parent?.isStyleRoot === true &&
          styleRecord !== undefined;
        if (styleRecord && info.namespaceURI === WORD_NS) {
          if (parent?.isStyleRoot && info.localName === 'name') {
            const value = attribute(attrs, 'val', scopes, ctx.budget);
            if (value !== undefined) styleRecord.name = value;
          } else if (parent?.isStyleRoot && info.localName === 'basedOn') {
            const value = attribute(attrs, 'val', scopes, ctx.budget);
            if (value !== undefined) styleRecord.basedOn = value;
          } else if (info.localName === 'outlineLvl' && parent?.isStyleParagraphProperties) {
            const value = attribute(attrs, 'val', scopes, ctx.budget);
            if (value !== undefined) styleRecord.outlineLevel = parseSmallInteger(value, ctx.budget);
          } else if (info.localName === 'numId' && parent?.isStyleNumberingProperties) {
            const value = attribute(attrs, 'val', scopes, ctx.budget);
            if (value !== undefined) styleRecord.numId = value;
          } else if (info.localName === 'ilvl' && parent?.isStyleNumberingProperties) {
            const value = attribute(attrs, 'val', scopes, ctx.budget);
            if (value !== undefined) styleRecord.ilvl = parseSmallInteger(value, ctx.budget);
          }
        }
        frames.push({
          namespaceURI: info.namespaceURI,
          localName: info.localName,
          declaredStyle,
          styleRecord,
          isStyleRoot: styleRoot,
          isStyleParagraphProperties: paragraphProperties,
          isStyleNumberingProperties:
            info.namespaceURI === WORD_NS &&
            info.localName === 'numPr' &&
            parent?.isStyleParagraphProperties === true,
          inParagraphProperties: paragraphProperties,
        });
      },
      onClose(_name, info) {
        ctx.budget.tick();
        const frame = frames.pop();
        scopes.pop();
        if (info.namespaceURI === WORD_NS && info.localName === 'style' && frame?.declaredStyle) {
          const declared = frame.declaredStyle;
          if (!raw.has(declared.id)) {
            declared.builtinLevel = headingFromName(declared.name, declared.id);
            raw.set(declared.id, declared);
          } else if (!duplicateWarned) {
            duplicateWarned = true;
            warnUnreadable(ctx);
          }
        }
      },
    },
    ctx,
  );

  if (!rootSeen) warnUnreadable(ctx);

  const levels = resolveLevels(raw, ctx);
  const resolved = new Map<string, DocxStyle>();
  for (const [id, style] of raw) {
    ctx.budget.tick();
    const level = levels.get(id) ?? undefined;
    const result: DocxStyle = { id };
    if (style.name !== undefined) result.name = style.name;
    if (style.basedOn !== undefined) result.basedOn = style.basedOn;
    if (level !== undefined) result.level = level;
    const numbering = inheritedNumbering(raw, id, ctx);
    if (numbering.numId !== undefined) result.numId = numbering.numId;
    if (numbering.ilvl !== undefined) result.ilvl = numbering.ilvl;
    resolved.set(id, result);
  }
  return resolved;
}

/** The nearest `numId` and `ilvl` along a style's `basedOn` chain; cycles stop at a visited style. */
function inheritedNumbering(
  raw: ReadonlyMap<string, MutableStyle>,
  id: string,
  ctx: XmlContext,
): { numId?: string; ilvl?: number } {
  const result: { numId?: string; ilvl?: number } = {};
  const visited = new Set<string>();
  let current = raw.get(id);
  while (current && !visited.has(current.id) && (result.numId === undefined || result.ilvl === undefined)) {
    ctx.budget.tick();
    visited.add(current.id);
    if (result.numId === undefined && current.numId !== undefined) result.numId = current.numId;
    if (result.ilvl === undefined && current.ilvl !== undefined) result.ilvl = current.ilvl;
    current = current.basedOn === undefined ? undefined : raw.get(current.basedOn);
  }
  return result;
}

function resolveLevels(
  raw: ReadonlyMap<string, MutableStyle>,
  ctx: XmlContext,
): Map<string, HeadingLevel | null> {
  const levels = new Map<string, HeadingLevel | null>();
  for (const id of raw.keys()) {
    ctx.budget.tick();
    if (levels.has(id)) continue;
    const chain: string[] = [];
    const visited = new Set<string>();
    let currentId: string | undefined = id;
    let resolvedLevel: HeadingLevel | null = null;
    while (currentId !== undefined) {
      ctx.budget.tick();
      if (levels.has(currentId)) {
        resolvedLevel = levels.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;
      visited.add(currentId);
      chain.push(currentId);
      const current = raw.get(currentId);
      if (!current) break;
      if (current.outlineLevel === 9) break;
      const explicitOutline = outlineHeading(current.outlineLevel);
      if (explicitOutline !== undefined) {
        resolvedLevel = explicitOutline;
        break;
      }
      if (current.builtinLevel !== undefined) {
        resolvedLevel = current.builtinLevel;
        break;
      }
      currentId = current.basedOn;
    }
    for (const item of chain) {
      ctx.budget.tick();
      levels.set(item, resolvedLevel);
    }
  }
  return levels;
}

function outlineHeading(value: number | undefined): HeadingLevel | undefined {
  return value !== undefined && value >= 0 && value <= 5 ? ((value + 1) as HeadingLevel) : undefined;
}

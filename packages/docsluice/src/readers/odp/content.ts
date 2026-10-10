import type { Cell } from '../../core/model.js';
import { scanXml } from '../../xml/index.js';
import type { XmlContext } from '../../xml/index.js';

const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const DRAW_NS = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const PRESENTATION_NS = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0';
const STYLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const SVG_NS = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const TABLE_NS = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const TEXT_NS = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
/** `text:s` stands for this many spaces at most. */
const MAX_SPACES = 1024;
/** Slide tables follow PowerPoint's 75 columns: repeats and spans are clamped to this many. */
const MAX_TABLE_SPAN = 75;
/** ODF list styles define levels 1 to 10. */
const MAX_LIST_LEVEL = 10;
/** Draw elements that hold no slide content of their own. */
const NOT_SHAPES: ReadonlySet<string> = new Set(['g', 'page', 'page-thumbnail', 'layer-set', 'layer']);

/** One list level of a `text:list-style`. */
export interface OdpListLevel {
  numbered: boolean;
  /** `style:num-format`: `1`, `a`, `A`, `i` or `I`. */
  format?: string;
  prefix?: string;
  suffix?: string;
  start?: number;
  char?: string;
}

/** Styles that change what a slide shows: list levels and hidden drawing-page styles. */
export interface OdpStyles {
  lists: Map<string, Map<number, OdpListLevel>>;
  hiddenPages: Set<string>;
}

export interface OdpParagraph {
  text: string;
  /** Present for a list item: its 0-based level and its list style level. */
  list?: { level: number; style: OdpListLevel | undefined };
}

export interface OdpShape {
  kind: 'text' | 'table';
  order: number;
  /** Top-left corner in millimetres. */
  x?: number;
  y?: number;
  /** `presentation:class`, such as `title`, `subtitle`, `outline`, `notes` or `footer`. */
  className?: string;
  paragraphs: OdpParagraph[];
  rows?: Cell[][];
  headerRows?: number;
}

export interface OdpSlide {
  name: string | undefined;
  hidden: boolean;
  shapes: OdpShape[];
  /** Speaker-notes paragraphs. */
  notes: string[];
}

export interface OdpContent {
  slides: OdpSlide[];
  hasExternalLinks: boolean;
  hasEmbeddedFiles: boolean;
}

/** An ODF length (`2.54cm`, `10mm`, `1in`, `72pt`, `6pc`, `96px`) in millimetres. */
export function lengthInMillimetres(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 32) return undefined;
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    if ((code >= 48 && code <= 57) || code === 46 || code === 45 || code === 43) end++;
    else break;
  }
  const number = Number(value.slice(0, end));
  if (end === 0 || !Number.isFinite(number)) return undefined;
  switch (value.slice(end)) {
    case 'mm':
      return number;
    case 'cm':
      return number * 10;
    case 'in':
      return number * 25.4;
    case 'pt':
      return (number * 25.4) / 72;
    case 'pc':
      return (number * 25.4) / 6;
    case 'px':
      return (number * 25.4) / 96;
    default:
      return undefined;
  }
}

function smallCount(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 9) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result >= 1 ? Math.min(result, maximum) : undefined;
}

/** Empty style maps, filled by {@link parseOdpXml} from `styles.xml` and then `content.xml`. */
export function emptyOdpStyles(): OdpStyles {
  return { lists: new Map(), hiddenPages: new Set() };
}

/**
 * Parse an ODP part with bounded SAX events. List styles and hidden drawing-page styles are added to
 * `styles` (so `styles.xml` can be read first); slides come from `office:presentation`. Shapes on a
 * page or in a group (`draw:g`, whose children carry page coordinates) keep their position for
 * reading order. Nothing recurses: lists, groups and tables are tracked with explicit stacks (SEC-8).
 */
export function parseOdpXml(input: Uint8Array, styles: OdpStyles, ctx: XmlContext): OdpContent {
  const content: OdpContent = { slides: [], hasExternalLinks: false, hasEmbeddedFiles: false };
  const scopes: Array<Map<string, string> | undefined> = [];
  const kinds: string[] = [];
  let presentation = 0;
  let page: OdpSlide | undefined;
  let notes = 0;
  let order = 0;
  let shape: OdpShape | undefined;
  let annotations = 0;
  /** The `text:list` elements open in the current shape, with their style names. */
  const lists: Array<string | undefined> = [];
  let paragraph: OdpParagraph | undefined;
  let tableDepth = 0;
  let row: Cell[] | undefined;
  let cell: { paragraphs: string[]; columnSpan: number; rowSpan: number; repeat: number } | undefined;
  let firstRowStyles = false;
  let headerRows = 0;
  let inHeaderRows = false;
  let listStyle: { name: string; levels: Map<number, OdpListLevel> } | undefined;
  let pageStyle: string | undefined;

  const resolve = (prefix: string): string | undefined => {
    if (prefix === 'xml') return XML_NS;
    for (let index = scopes.length - 1; index >= 0; index--) {
      ctx.budget.tick();
      const uri = scopes[index]?.get(prefix);
      if (uri !== undefined) return uri;
    }
    return undefined;
  };
  const reader = (attrs: Map<string, string>) => {
    return (uri: string, local: string): string | undefined => {
      for (const [name, value] of attrs) {
        ctx.budget.tick();
        const colon = name.indexOf(':');
        if (colon < 0 || name.slice(colon + 1) !== local) continue;
        if (resolve(name.slice(0, colon)) === uri) return value;
      }
      return undefined;
    };
  };

  const finishCell = (): void => {
    const open = cell!;
    cell = undefined;
    if (!row) return;
    const text = open.paragraphs.join('\n');
    for (let copy = 0; copy < open.repeat; copy++) {
      ctx.budget.tick();
      if (!ctx.budget.addCells(1)) return;
      const value: Cell = { text };
      if (open.columnSpan > 1) value.colSpan = open.columnSpan;
      if (open.rowSpan > 1) value.rowSpan = open.rowSpan;
      row.push(value);
    }
  };

  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        let declared: Map<string, string> | undefined;
        for (const [name, value] of attrs) {
          ctx.budget.tick();
          if (name.startsWith('xmlns:')) (declared ??= new Map()).set(name.slice(6), value);
        }
        scopes.push(declared);
        const uri = info.namespaceURI;
        const local = info.localName;
        const attr = reader(attrs);
        let kind = '';
        const href = attr(XLINK_NS, 'href');
        if (href !== undefined && isExternal(href, ctx)) content.hasExternalLinks = true;
        if (uri === DRAW_NS && (local === 'object' || local === 'object-ole' || local === 'plugin'))
          content.hasEmbeddedFiles = true;

        // Styles: list levels and drawing-page visibility.
        if (uri === TEXT_NS && local === 'list-style') {
          const name = attr(STYLE_NS, 'name');
          if (name !== undefined) {
            listStyle = { name, levels: new Map() };
            kind = 'list-style';
          }
        } else if (
          listStyle &&
          uri === TEXT_NS &&
          (local === 'list-level-style-number' || local === 'list-level-style-bullet')
        ) {
          const level = smallCount(attr(TEXT_NS, 'level'), MAX_LIST_LEVEL) ?? 1;
          const numbered = local === 'list-level-style-number';
          const entry: OdpListLevel = { numbered };
          if (numbered) {
            const format = attr(STYLE_NS, 'num-format');
            if (format !== undefined) entry.format = format;
            const prefix = attr(STYLE_NS, 'num-prefix');
            if (prefix !== undefined) entry.prefix = prefix;
            const suffix = attr(STYLE_NS, 'num-suffix');
            if (suffix !== undefined) entry.suffix = suffix;
            const start = smallCount(attr(TEXT_NS, 'start-value'), 32_767);
            if (start !== undefined) entry.start = start;
          } else {
            const char = attr(TEXT_NS, 'bullet-char');
            if (char !== undefined) entry.char = char.slice(0, 4);
          }
          if (!listStyle.levels.has(level)) listStyle.levels.set(level, entry);
        } else if (uri === STYLE_NS && local === 'style' && attr(STYLE_NS, 'family') === 'drawing-page') {
          pageStyle = attr(STYLE_NS, 'name');
          kind = 'page-style';
        } else if (pageStyle !== undefined && uri === STYLE_NS && local === 'drawing-page-properties') {
          if (attr(PRESENTATION_NS, 'visibility') === 'hidden') styles.hiddenPages.add(pageStyle);
        } else if (uri === OFFICE_NS && local === 'presentation') {
          presentation++;
          kind = 'presentation';
        } else if (presentation > 0 && !page && uri === DRAW_NS && local === 'page') {
          page = {
            name: attr(DRAW_NS, 'name'),
            hidden: styles.hiddenPages.has(attr(DRAW_NS, 'style-name') ?? ''),
            shapes: [],
            notes: [],
          };
          order = 0;
          kind = 'page';
        } else if (page && !shape && uri === PRESENTATION_NS && local === 'notes') {
          notes++;
          kind = 'notes';
        } else if (page && !shape && uri === DRAW_NS && !NOT_SHAPES.has(local)) {
          const className = attr(PRESENTATION_NS, 'class');
          shape = { kind: 'text', order: order++, paragraphs: [] };
          if (className !== undefined) shape.className = className;
          const x = lengthInMillimetres(attr(SVG_NS, 'x'));
          const y = lengthInMillimetres(attr(SVG_NS, 'y'));
          if (x !== undefined && y !== undefined) {
            shape.x = x;
            shape.y = y;
          }
          kind = 'shape';
        } else if (shape) {
          if (uri === TABLE_NS && local === 'table') {
            tableDepth++;
            if (tableDepth === 1 && !shape.rows) {
              shape.kind = 'table';
              shape.rows = [];
              firstRowStyles = attr(TABLE_NS, 'use-first-row-styles') === 'true';
              headerRows = 0;
            }
            kind = 'table';
          } else if (tableDepth === 1 && uri === TABLE_NS && local === 'table-header-rows') {
            inHeaderRows = true;
            kind = 'header-rows';
          } else if (tableDepth === 1 && uri === TABLE_NS && local === 'table-row') {
            row = [];
            kind = 'row';
          } else if (
            tableDepth === 1 &&
            row &&
            uri === TABLE_NS &&
            (local === 'table-cell' || local === 'covered-table-cell')
          ) {
            const covered = local === 'covered-table-cell';
            cell = {
              paragraphs: [],
              columnSpan: covered
                ? 1
                : (smallCount(attr(TABLE_NS, 'number-columns-spanned'), MAX_TABLE_SPAN) ?? 1),
              rowSpan: covered ? 1 : (smallCount(attr(TABLE_NS, 'number-rows-spanned'), MAX_TABLE_SPAN) ?? 1),
              repeat: smallCount(attr(TABLE_NS, 'number-columns-repeated'), MAX_TABLE_SPAN) ?? 1,
            };
            kind = covered ? 'covered' : 'cell';
          } else if (uri === TEXT_NS && local === 'list') {
            lists.push(attr(TEXT_NS, 'style-name') ?? lists.at(-1));
            kind = 'list';
          } else if (uri === TEXT_NS && (local === 'p' || local === 'h') && !paragraph && annotations === 0) {
            paragraph = { text: '' };
            if (lists.length > 0 && tableDepth === 0) {
              const level = Math.min(lists.length, MAX_LIST_LEVEL);
              const name = lists.at(-1);
              paragraph.list = {
                level: level - 1,
                style: name === undefined ? undefined : styles.lists.get(name)?.get(level),
              };
            }
            kind = 'p';
          } else if (paragraph && uri === TEXT_NS && local === 's') {
            paragraph.text += ' '.repeat(smallCount(attr(TEXT_NS, 'c'), MAX_SPACES) ?? 1);
          } else if (paragraph && uri === TEXT_NS && local === 'tab') paragraph.text += '\t';
          else if (paragraph && uri === TEXT_NS && local === 'line-break') paragraph.text += '\n';
          else if (uri === OFFICE_NS && local === 'annotation') {
            annotations++;
            kind = 'annotation';
          }
        }
        kinds.push(kind);
      },
      onText(text) {
        if (paragraph && annotations === 0) paragraph.text += text;
      },
      onClose() {
        ctx.budget.tick();
        scopes.pop();
        const kind = kinds.pop();
        switch (kind) {
          case 'list-style':
            if (listStyle && !styles.lists.has(listStyle.name))
              styles.lists.set(listStyle.name, listStyle.levels);
            listStyle = undefined;
            break;
          case 'page-style':
            pageStyle = undefined;
            break;
          case 'presentation':
            presentation--;
            break;
          case 'page':
            content.slides.push(page!);
            page = undefined;
            break;
          case 'notes':
            notes--;
            break;
          case 'shape': {
            const finished = shape!;
            shape = undefined;
            lists.length = 0;
            if (notes > 0) {
              // Speaker notes: the notes placeholder and plain text boxes, not the slide image or numbers.
              if (finished.className === undefined || finished.className === 'notes') {
                for (const item of finished.paragraphs) {
                  ctx.budget.tick();
                  if (item.text.trim().length > 0) page!.notes.push(item.text);
                }
              }
            } else {
              // `table:table-header-rows` counts; first-row styles alone make the first row a header.
              if (finished.rows)
                finished.headerRows = Math.min(
                  Math.max(headerRows, firstRowStyles ? 1 : 0),
                  finished.rows.length,
                );
              page!.shapes.push(finished);
            }
            break;
          }
          case 'table':
            tableDepth--;
            break;
          case 'header-rows':
            inHeaderRows = false;
            break;
          case 'row':
            if (row && row.length > 0) {
              shape?.rows?.push(row);
              if (inHeaderRows) headerRows++;
            }
            row = undefined;
            break;
          case 'cell':
          case 'covered':
            if (cell) {
              if (kind === 'covered') cell.paragraphs = [];
              finishCell();
            }
            break;
          case 'list':
            lists.pop();
            break;
          case 'annotation':
            annotations--;
            break;
          case 'p':
            if (paragraph) {
              if (cell) cell.paragraphs.push(paragraph.text);
              else if (tableDepth === 0) shape?.paragraphs.push(paragraph);
              paragraph = undefined;
            }
            break;
        }
      },
    },
    ctx,
  );
  return content;
}

/** A link target with a URI scheme or a network path, as opposed to a place in the package. */
function isExternal(target: string, ctx: XmlContext): boolean {
  for (let index = 0; index < target.length; index++) {
    ctx.budget.tick();
    const code = target.charCodeAt(index);
    if (code === 58) return index > 1;
    if (code === 47 || code === 92) return index === 0 && target.charCodeAt(1) === code;
    if (code === 35 || code <= 0x20) return false;
  }
  return false;
}

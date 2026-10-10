import type { DocBuilder } from '../../core/builder.js';
import type { ResolvedOptions } from '../../core/options.js';
import type { ReadContext } from '../../core/reader.js';
import type { Cell } from '../../core/model.js';
import type { XmlContext, XmlElementInfo } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import type { DocxStyle } from './styles.js';
import { MathBuilder } from './math.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const VML_NS = 'urn:schemas-microsoft-com:vml';
const OFFICE_NS = 'urn:schemas-microsoft-com:office:office';
const MATH_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/math';
/** English Metric Units per pixel at 96 dpi. */
const EMU_PER_PIXEL = 9525;
const UNDERSTOOD_NAMESPACES = new Set([WORD_NS, REL_NS, MC_NS]);

/** Resolved relationship data, supplied by the shared OOXML relationships parser. */
export interface DocxRelationship {
  target: string;
  external: boolean;
  /** Resolved package part path, when available. */
  part?: string;
}

export type DocxRelationships = ReadonlyMap<string, DocxRelationship>;

/** A completed paragraph offered to reader features before default block emission. */
export interface DocxParagraph {
  text: string;
  styleId?: string;
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  numId?: string;
  ilvl?: number;
  runs?: Array<{ text: string; bold?: boolean; italic?: boolean; href?: string }>;
  /** Notes (DOC-5) and images (DOC-8) anchored in this paragraph, in document order. */
  anchors?: DocxAnchor[];
  loc: { path?: string };
}

/** A footnote, endnote or comment referenced from the body by its `w:id`. */
/** An image anchored in the body: a DrawingML `w:drawing` or a VML picture (DOC-8). */
export interface DocxImageRef {
  role: 'image';
  /** Relationship id of the picture (`r:embed`, `r:link` or `v:imagedata r:id`). */
  relationshipId?: string;
  alt?: string;
  /** Pixels at 96 dpi. */
  width?: number;
  height?: number;
}

/** An embedded or linked OLE object (`o:OLEObject`) read as a child document (DOC-12). */
export interface DocxObjectRef {
  role: 'object';
  /** Relationship id of the object part (`r:id`). */
  relationshipId: string;
}

/** Something emitted right after the block that anchors it. */
export type DocxAnchor = DocxNoteRef | DocxImageRef | DocxObjectRef;

export interface DocxNoteRef {
  role: 'footnote' | 'endnote' | 'comment';
  id: string;
}

/** Return `true` after emitting or consuming this paragraph to suppress default emission. */
export type DocxParagraphHandler = (paragraph: DocxParagraph) => boolean | void;

/** Reader hooks around the body scan. All are optional. */
export interface DocxBodyHooks {
  onParagraph?: DocxParagraphHandler;
  /** Called before each table block is emitted. */
  onTable?: () => void;
  /** Called after a paragraph or table is emitted, with the notes and images it anchors. */
  onAnchors?: (anchors: readonly DocxAnchor[]) => void;
  /** Called for each section `w:headerReference`/`w:footerReference` relationship id. */
  onSectionReference?: (kind: 'header' | 'footer', relationshipId: string) => void;
  /** Called once after the scan and before any body block is emitted. */
  beforeEmit?: () => void;
}

interface ParagraphState {
  text: string;
  runs: Array<{ text: string; bold?: boolean; italic?: boolean; href?: string }>;
  styleId?: string;
  /** Direct `w:outlineLvl` (0-based); it overrides the style's heading level. */
  outlineLevel?: number;
  numId?: string;
  ilvl?: number;
  anchors?: DocxAnchor[];
  /** Paragraph-mark revisions (`w:pPr/w:rPr/w:del|w:ins`). */
  markDeleted?: boolean;
  markInserted?: boolean;
}

interface RunState {
  bold?: boolean;
  italic?: boolean;
  /** Direct `w:vanish`; it overrides any style (DOC-9). */
  hidden?: boolean;
  /** The run's character style (`w:rStyle`) is hidden. */
  styleHidden?: boolean;
}

/** Nested fields tracked at most; deeper `begin`/`end` pairs are only counted. */
const MAX_FIELD_DEPTH = 64;

interface CellState {
  text: string;
  colSpan: number;
  vMerge?: 'restart' | 'continue';
}

interface RowState {
  cells: CellState[];
  header: boolean;
}

interface TableState {
  rows: RowState[];
  row?: RowState;
  cell?: CellState;
  /** Tables nested in this one, in document order, emitted right after it. */
  nested: TableEvent[];
  /** Notes and images anchored in any cell, emitted after the outermost table. */
  anchors: DocxAnchor[];
}

interface TableEvent {
  table: { rows: Cell[][]; headerRows: number };
  loc: { path?: string };
  anchors?: DocxAnchor[];
}

type BodyEvent = DocxParagraph | TableEvent;

// Word tables have at most 63 grid columns. Wider spans are clamped, so a few bytes of
// gridSpan cannot expand into millions of placeholder cells (SEC-12).
const MAX_GRID_SPAN = 64;

interface AlternateState {
  selected: boolean | undefined;
}

interface Frame {
  info: XmlElementInfo;
  namespaceURI?: string;
  localName: string;
  namespaceScope: Map<string, string>;
  skipped: boolean;
  paragraph?: ParagraphState;
  run?: RunState;
  hyperlink?: string;
  textElement: boolean;
  alternate?: AlternateState;
  inBody: boolean;
  paragraphProperties: boolean;
  numberingProperties: boolean;
  /** Set on a kept `w:tbl`; flattened tables past `blockDepth` set `flattenedTable` instead. */
  table?: TableState;
  flattenedTable?: boolean;
  /** Set on `wp:inline`/`wp:anchor` and `v:shape`: the picture being read. */
  image?: DocxImageRef;
  /** Set on run-level `w:ins`/`w:moveTo` ('ins') and `w:del`/`w:moveFrom` ('del'). */
  revision?: 'ins' | 'del';
  /** In `show` mode, whether this revision's opening marker has been written. */
  revisionMarked?: boolean;
  /** Set on Office Math elements that opened a node in the math builder. */
  mathNode?: boolean;
  /** Set on Office Math property elements (`m:*Pr`), whose content is never text. */
  mathProperties?: boolean;
  /** Set on `m:t`. */
  mathText?: boolean;
}

interface BodyContext extends XmlContext {
  out: DocBuilder;
  options: Pick<ResolvedOptions, 'runs'> & Partial<Pick<ResolvedOptions, 'revisions' | 'includeHidden'>>;
}

const STOP = new Error('DOCX output limit reached.');

function lookupNamespace(
  prefix: string,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): string | undefined {
  if (current.has(prefix)) return current.get(prefix);
  for (let index = frames.length - 1; index >= 0; index--) {
    budget.tick();
    const scope = frames[index]!.namespaceScope;
    if (scope.has(prefix)) return scope.get(prefix);
  }
  return prefix === 'xml' ? 'http://www.w3.org/XML/1998/namespace' : undefined;
}

function wordAttribute(
  attrs: Map<string, string>,
  localName: string,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== localName) continue;
    const prefix = qualifiedName.slice(0, colon);
    if (lookupNamespace(prefix, frames, current, budget) === WORD_NS) return value;
  }
  return undefined;
}

function unqualifiedAttribute(attrs: Map<string, string>, name: string): string | undefined {
  return attrs.get(name);
}

function boolValue(value: string | undefined): boolean {
  return value === undefined || (value !== '0' && value !== 'false' && value !== 'off');
}

function parseLevel(value: string, budget: XmlContext['budget']): number | undefined {
  if (value.length === 0 || value.length > 2) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result;
}

function appendRun(
  paragraph: ParagraphState,
  text: string,
  frames: readonly Frame[],
  keepRuns: boolean,
  budget: XmlContext['budget'],
): void {
  paragraph.text += text;
  if (!keepRuns || text.length === 0) return;
  let run: RunState | undefined;
  let href: string | undefined;
  for (let index = frames.length - 1; index >= 0 && (run === undefined || href === undefined); index--) {
    budget.tick();
    const frame = frames[index]!;
    run ??= frame.run;
    href ??= frame.hyperlink;
  }
  const previous = paragraph.runs.at(-1);
  if (previous && previous.bold === run?.bold && previous.italic === run?.italic && previous.href === href) {
    previous.text += text;
  } else {
    const next: (typeof paragraph.runs)[number] = { text };
    if (run?.bold !== undefined) next.bold = run.bold;
    if (run?.italic !== undefined) next.italic = run.italic;
    if (href !== undefined) next.href = href;
    paragraph.runs.push(next);
  }
}

function cloneRuns(runs: ParagraphState['runs'], budget: XmlContext['budget']): ParagraphState['runs'] {
  const copies: ParagraphState['runs'] = [];
  for (const run of runs) {
    budget.tick();
    const copy: (typeof copies)[number] = { text: run.text };
    if (run.bold !== undefined) copy.bold = run.bold;
    if (run.italic !== undefined) copy.italic = run.italic;
    if (run.href !== undefined) copy.href = run.href;
    copies.push(copy);
  }
  return copies;
}

function supportedChoice(
  requires: string | undefined,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): boolean {
  if (requires === undefined || requires.length === 0) return false;
  let cursor = 0;
  let found = false;
  while (cursor < requires.length) {
    budget.tick();
    while (cursor < requires.length && isWhitespace(requires.charCodeAt(cursor))) cursor++;
    if (cursor >= requires.length) break;
    const start = cursor;
    while (cursor < requires.length && !isWhitespace(requires.charCodeAt(cursor))) cursor++;
    const namespace = lookupNamespace(requires.slice(start, cursor), frames, current, budget);
    if (!namespace || !UNDERSTOOD_NAMESPACES.has(namespace)) return false;
    found = true;
  }
  return found;
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function location(ctx: XmlContext): { path?: string } {
  return ctx.path ? { path: ctx.path } : {};
}

/**
 * Scan the WordprocessingML main body and emit heading/paragraph blocks in XML order.
 * The input is a single uncompressed `word/document.xml` part, never the whole DOCX zip.
 */
export function scanDocxBody(
  input: Uint8Array | string,
  context: ReadContext | BodyContext,
  styles: ReadonlyMap<string, DocxStyle>,
  relationships: DocxRelationships,
  hooks: DocxBodyHooks = {},
): void {
  const ctx = context as BodyContext;
  const { onParagraph, onTable, onAnchors } = hooks;
  // References that appear between paragraphs (a comment range start) attach to the next one.
  const pendingAnchors: DocxAnchor[] = [];
  const seenComments = new Set<string>();
  const revisions = ctx.options.revisions ?? 'accept';
  let insertedDepth = 0;
  let deletedDepth = 0;
  let revisionWarned = false;
  // A paragraph whose mark is removed under the chosen mode joins the next paragraph.
  let carry: ParagraphState | undefined;
  // Complex fields (17.16.18): `true` while a field is in its code, before `separate`.
  const fields: boolean[] = [];
  let fieldCodeDepth = 0;
  let untrackedFields = 0;
  const includeHidden = ctx.options.includeHidden === true;
  let hiddenSkipped = false;
  const math = new MathBuilder(ctx.budget);
  let mathPropertiesDepth = 0;
  let mathTextDepth = 0;
  const noteRevision = (): void => {
    if (revisionWarned) return;
    revisionWarned = true;
    ctx.warnings.add({
      code: 'HIDDEN_CONTENT',
      message: `The document has tracked changes; they were applied in "${revisions}" mode.`,
    });
  };
  const revisionVisible = (): boolean =>
    revisions === 'show' || (revisions === 'accept' ? deletedDepth === 0 : insertedDepth === 0);
  const anchor = (item: DocxAnchor): void => {
    const paragraph = paragraphs.at(-1);
    if (paragraph) (paragraph.anchors ??= []).push(item);
    else pendingAnchors.push(item);
  };
  const frames: Frame[] = [];
  const paragraphs: ParagraphState[] = [];
  let activeTextDepth = 0;
  let skippedDepth = 0;
  let stagedOutputChars = 0;
  let outputStopped = false;
  let emptyParagraphPending = false;
  let rootSeen = false;
  let validRoot = false;
  let bodySeen = false;
  let rootWarningSent = false;
  const events: BodyEvent[] = [];
  const tables: TableState[] = [];
  let flattenedTables = 0;
  let depthWarned = false;

  const warnUnreadableRoot = (): void => {
    if (rootWarningSent) return;
    rootWarningSent = true;
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The Word document body part could not be read.' });
  };

  /** Write the opening markers of `show`-mode revisions that are about to receive text. */
  const openRevisionMarkers = (): void => {
    for (const frame of frames) {
      if (frame.revision && !frame.revisionMarked) {
        frame.revisionMarked = true;
        append(frame.revision === 'ins' ? '[+' : '[-', true);
      }
    }
  };

  /** Direct `w:vanish` wins, then the run's character style, then the paragraph style (DOC-9). */
  const hiddenText = (paragraph: ParagraphState): boolean => {
    const run = nearestRun(frames, ctx.budget);
    if (run?.hidden !== undefined) return run.hidden;
    if (run?.styleHidden) return true;
    const style = paragraph.styleId === undefined ? undefined : styles.get(paragraph.styleId);
    return style?.character !== true && style?.hidden === true;
  };

  const append = (text: string, marker = false): void => {
    const paragraph = paragraphs.at(-1);
    if (text.length === 0 || outputStopped || !paragraph) return;
    if (!marker && !revisionVisible()) return;
    // Field codes are never text; only the result after `separate` is (DOC-10).
    if (!marker && fieldCodeDepth > 0) return;
    if (!marker && !includeHidden && hiddenText(paragraph)) {
      hiddenSkipped = true;
      return;
    }
    if (!marker && revisions === 'show' && (insertedDepth > 0 || deletedDepth > 0)) openRevisionMarkers();
    ctx.budget.tick();
    if (!ctx.budget.checkOutputChars(stagedOutputChars + text.length)) {
      outputStopped = true;
      throw STOP;
    }
    stagedOutputChars += text.length;
    appendRun(paragraph, text, frames, ctx.options.runs, ctx.budget);
  };

  const finishParagraph = (incoming: ParagraphState): void => {
    let paragraph = incoming;
    if (carry) {
      // The previous paragraph's mark was removed: its content flows into this paragraph.
      paragraph = {
        ...paragraph,
        text: carry.text + paragraph.text,
        runs: [...carry.runs, ...paragraph.runs],
      };
      const anchors = [...(carry.anchors ?? []), ...(paragraph.anchors ?? [])];
      if (anchors.length > 0) paragraph.anchors = anchors;
      carry = undefined;
    }
    if (
      (revisions === 'accept' && paragraph.markDeleted) ||
      (revisions === 'reject' && paragraph.markInserted)
    ) {
      carry = paragraph;
      return;
    }
    const cell = tables.at(-1)?.cell;
    if (cell) {
      // Cell paragraphs become the cell's text, one line each (DOC-4).
      if (paragraph.text.length > 0)
        cell.text += cell.text.length > 0 ? `\n${paragraph.text}` : paragraph.text;
      if (paragraph.anchors) tables[0]!.anchors.push(...paragraph.anchors);
      return;
    }
    const baseLoc = location(ctx);
    const style = paragraph.styleId === undefined ? undefined : styles.get(paragraph.styleId);
    // Outline levels 0-5 are headings 1-6; any other direct level (9 is body text) is not a heading.
    const outline = paragraph.outlineLevel;
    const level =
      outline !== undefined
        ? outline <= 5
          ? ((outline + 1) as 1 | 2 | 3 | 4 | 5 | 6)
          : undefined
        : style === undefined
          ? builtinHeadingLevel(paragraph.styleId)
          : style.level;
    const event: DocxParagraph = { text: paragraph.text, loc: baseLoc };
    if (paragraph.styleId !== undefined) event.styleId = paragraph.styleId;
    if (level !== undefined) event.level = level;
    if (paragraph.numId !== undefined) event.numId = paragraph.numId;
    if (paragraph.ilvl !== undefined) event.ilvl = paragraph.ilvl;
    if (ctx.options.runs) event.runs = cloneRuns(paragraph.runs, ctx.budget);
    if (paragraph.anchors) event.anchors = paragraph.anchors;
    if (paragraph.text.length === 0) {
      if (paragraph.anchors) events.push({ text: '', loc: baseLoc, anchors: paragraph.anchors });
      if (onParagraph) emptyParagraphPending = true;
      return;
    }
    if (emptyParagraphPending) {
      events.push({ text: '', loc: baseLoc });
      emptyParagraphPending = false;
    }
    events.push(event);
  };

  try {
    scanXml(
      input,
      {
        onOpen(_name, attrs, info) {
          ctx.budget.tick();
          if (frames.length === 0 && !rootSeen) {
            rootSeen = true;
            validRoot = info.namespaceURI === WORD_NS && info.localName === 'document';
            if (!validRoot) warnUnreadableRoot();
          }
          const namespaceScope = new Map<string, string>();
          for (const [qualifiedName, value] of attrs) {
            ctx.budget.tick();
            if (qualifiedName === 'xmlns') namespaceScope.set('', value);
            else if (qualifiedName.startsWith('xmlns:')) namespaceScope.set(qualifiedName.slice(6), value);
          }
          const parent = frames.at(-1);
          const skippedByParent = parent?.skipped ?? false;
          const bodyRoot =
            validRoot &&
            frames.length === 1 &&
            parent?.namespaceURI === WORD_NS &&
            parent.localName === 'document' &&
            info.namespaceURI === WORD_NS &&
            info.localName === 'body';
          const inBody = bodyRoot || (parent?.inBody ?? false);
          if (bodyRoot) bodySeen = true;
          const isWord = inBody && info.namespaceURI === WORD_NS;
          const isAlternate = inBody && info.namespaceURI === MC_NS && info.localName === 'AlternateContent';
          const alternate: AlternateState | undefined = isAlternate ? { selected: undefined } : undefined;
          let skipped = skippedByParent;

          if (!skipped && isWord && info.localName === 'txbxContent') {
            const anchorParagraph = paragraphs.at(-1);
            if (anchorParagraph && anchorParagraph.text.length > 0) {
              finishParagraph(anchorParagraph);
              anchorParagraph.text = '';
              anchorParagraph.runs.length = 0;
            }
          }

          if (inBody && info.namespaceURI === MC_NS && info.localName === 'Choice') {
            let alternateFrame: Frame | undefined;
            for (let index = frames.length - 1; index >= 0; index--) {
              const candidate = frames[index]!;
              if (candidate.alternate) {
                alternateFrame = candidate;
                break;
              }
            }
            const alreadySelected = alternateFrame?.alternate?.selected === true;
            const selected =
              !skippedByParent &&
              !alreadySelected &&
              supportedChoice(unqualifiedAttribute(attrs, 'Requires'), frames, namespaceScope, ctx.budget);
            if (selected && alternateFrame?.alternate) alternateFrame.alternate.selected = true;
            skipped ||= !selected;
          } else if (inBody && info.namespaceURI === MC_NS && info.localName === 'Fallback') {
            let alternateFrame: Frame | undefined;
            for (let index = frames.length - 1; index >= 0; index--) {
              const candidate = frames[index]!;
              if (candidate.alternate) {
                alternateFrame = candidate;
                break;
              }
            }
            skipped ||= alternateFrame?.alternate?.selected === true;
          }

          const frame: Frame = {
            info,
            namespaceURI: info.namespaceURI,
            localName: info.localName,
            namespaceScope,
            skipped,
            textElement: isWord && (info.localName === 't' || info.localName === 'delText'),
            alternate,
            inBody,
            paragraphProperties: isWord && info.localName === 'pPr' && parent?.paragraph !== undefined,
            numberingProperties: isWord && info.localName === 'numPr' && parent?.paragraphProperties === true,
          };
          if (skipped) skippedDepth++;
          if (isWord && info.localName === 'p') {
            frame.paragraph = { text: '', runs: [] };
            if (pendingAnchors.length > 0) frame.paragraph.anchors = pendingAnchors.splice(0);
            paragraphs.push(frame.paragraph);
          }
          if (!skipped && isWord) {
            const role =
              info.localName === 'footnoteReference'
                ? 'footnote'
                : info.localName === 'endnoteReference'
                  ? 'endnote'
                  : info.localName === 'commentRangeStart' || info.localName === 'commentReference'
                    ? 'comment'
                    : undefined;
            const id = role ? wordAttribute(attrs, 'id', frames, namespaceScope, ctx.budget) : undefined;
            // A comment has a range start and a reference; it is placed once, at whichever comes first.
            if (role && id !== undefined && !(role === 'comment' && seenComments.has(id))) {
              if (role === 'comment') seenComments.add(id);
              anchor({ role, id });
            }
            if (info.localName === 'headerReference' || info.localName === 'footerReference') {
              const relationshipId = relationshipAttribute(attrs, 'id', frames, namespaceScope, ctx.budget);
              if (relationshipId !== undefined)
                hooks.onSectionReference?.(
                  info.localName === 'headerReference' ? 'header' : 'footer',
                  relationshipId,
                );
            }
          }
          if (isWord && info.localName === 'r') frame.run = {};
          if (isWord && info.localName === 'hyperlink') {
            const relationshipId = relationshipAttribute(attrs, 'id', frames, namespaceScope, ctx.budget);
            if (relationshipId !== undefined) {
              const relationship = relationships.get(relationshipId);
              if (relationship) frame.hyperlink = relationship.target;
            }
          }
          if (!skipped && isWord && (info.localName === 'b' || info.localName === 'i')) {
            const run = nearestRun(frames, ctx.budget);
            const enabled = boolValue(wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget));
            if (run && info.localName === 'b') run.bold = enabled;
            else if (run && info.localName === 'i') run.italic = enabled;
          }
          if (
            !skipped &&
            isWord &&
            (info.localName === 'vanish' || info.localName === 'rStyle') &&
            parent?.localName === 'rPr' &&
            frames.at(-2)?.run
          ) {
            const run = frames.at(-2)!.run!;
            const value = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
            if (info.localName === 'vanish') run.hidden = boolValue(value);
            else if (value !== undefined) run.styleHidden = styles.get(value)?.hidden === true;
          }
          if (!skipped && isWord && info.localName === 'fldChar' && revisionVisible()) {
            const type = wordAttribute(attrs, 'fldCharType', frames, namespaceScope, ctx.budget);
            if (type === 'begin') {
              if (fields.length < MAX_FIELD_DEPTH) {
                fields.push(true);
                fieldCodeDepth++;
              } else untrackedFields++;
            } else if (type === 'separate' && untrackedFields === 0 && fields.at(-1) === true) {
              fields[fields.length - 1] = false;
              fieldCodeDepth--;
            } else if (type === 'end') {
              if (untrackedFields > 0) untrackedFields--;
              else if (fields.pop() === true) fieldCodeDepth--;
            }
          }
          if (!skipped && inBody && info.namespaceURI === OFFICE_NS && info.localName === 'OLEObject') {
            const relationshipId = relationshipAttribute(attrs, 'id', frames, namespaceScope, ctx.budget);
            if (relationshipId !== undefined && revisionVisible()) anchor({ role: 'object', relationshipId });
          }
          if (!skipped && inBody && info.namespaceURI === MATH_NS) {
            const local = info.localName;
            if (mathPropertiesDepth > 0 || (local.endsWith('Pr') && local !== 'Pr')) {
              if (mathPropertiesDepth === 0) frame.mathProperties = true;
              else math.property(local, wordlessValue(attrs, frames, namespaceScope, ctx.budget));
              if (frame.mathProperties) mathPropertiesDepth++;
            } else if (local === 't') {
              frame.mathText = true;
              mathTextDepth++;
            } else if (local !== 'r') {
              frame.mathNode = math.open(local);
            }
          }
          if (!skipped && isWord && info.localName === 'pStyle' && parent?.paragraphProperties) {
            const paragraph = paragraphs.at(-1);
            const styleId = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
            if (paragraph && styleId !== undefined) paragraph.styleId = styleId;
          }
          if (!skipped && isWord && info.localName === 'outlineLvl' && parent?.paragraphProperties) {
            const paragraph = paragraphs.at(-1);
            const value = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
            const outlineLevel = value === undefined ? undefined : parseLevel(value, ctx.budget);
            if (paragraph && outlineLevel !== undefined) paragraph.outlineLevel = outlineLevel;
          }
          if (
            !skipped &&
            isWord &&
            (info.localName === 'numId' || info.localName === 'ilvl') &&
            parent?.numberingProperties
          ) {
            const paragraph = paragraphs.at(-1);
            const value = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
            if (paragraph && value !== undefined) {
              if (info.localName === 'numId') paragraph.numId = value;
              else {
                const levelValue = parseLevel(value, ctx.budget);
                if (levelValue !== undefined) paragraph.ilvl = levelValue;
              }
            }
          }
          if (!skipped && isWord && info.localName === 'tbl') {
            if (tables.length + flattenedTables >= ctx.budget.limits.blockDepth) {
              frame.flattenedTable = true;
              flattenedTables++;
              if (!depthWarned) {
                depthWarned = true;
                ctx.warnings.add({
                  code: 'DEPTH_LIMIT',
                  message: `Word tables were flattened at the configured block depth of ${ctx.budget.limits.blockDepth}.`,
                });
              }
            } else {
              frame.table = { rows: [], nested: [], anchors: [] };
              tables.push(frame.table);
            }
          }
          const table = flattenedTables === 0 ? tables.at(-1) : undefined;
          if (!skipped && isWord && table) {
            if (info.localName === 'tr') {
              table.row = { cells: [], header: false };
              table.rows.push(table.row);
            } else if (info.localName === 'tblHeader' && parent?.localName === 'trPr' && table.row) {
              table.row.header = boolValue(wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget));
            } else if (info.localName === 'tc' && table.row) {
              table.cell = { text: '', colSpan: 1 };
              table.row.cells.push(table.cell);
            } else if (info.localName === 'gridSpan' && parent?.localName === 'tcPr' && table.cell) {
              const span = parseSpan(
                wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget),
                ctx.budget,
              );
              if (span !== undefined) table.cell.colSpan = Math.min(Math.max(span, 1), MAX_GRID_SPAN);
            } else if (info.localName === 'vMerge' && parent?.localName === 'tcPr' && table.cell) {
              const value = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
              table.cell.vMerge = value === 'restart' ? 'restart' : 'continue';
            }
          }
          if (!skipped && isWord && (info.localName === 'ins' || info.localName === 'del')) {
            if (parent?.localName === 'rPr' && frames.at(-2)?.paragraphProperties) {
              // A revised paragraph mark (w:pPr/w:rPr/w:ins|w:del).
              noteRevision();
              const paragraph = paragraphs.at(-1);
              if (paragraph && info.localName === 'del') paragraph.markDeleted = true;
              else if (paragraph) paragraph.markInserted = true;
            } else if (
              parent?.localName !== 'rPr' &&
              parent?.localName !== 'trPr' &&
              parent?.localName !== 'tcPr'
            ) {
              frame.revision = info.localName;
            }
          }
          if (!skipped && isWord && (info.localName === 'moveTo' || info.localName === 'moveFrom')) {
            frame.revision = info.localName === 'moveTo' ? 'ins' : 'del';
          }
          if (frame.revision) {
            noteRevision();
            if (frame.revision === 'ins') insertedDepth++;
            else deletedDepth++;
          }
          if (
            !skipped &&
            (info.namespaceURI === WP_NS || info.namespaceURI === A_NS || info.namespaceURI === VML_NS)
          ) {
            readImageElement(frame, parent, attrs, info, frames, namespaceScope, ctx.budget);
          }
          if (!skipped && isWord && info.localName === 'tab') append('\t');
          if (!skipped && isWord && info.localName === 'br') append('\n');
          frames.push(frame);
          if (frame.textElement) activeTextDepth++;
        },
        onText(text) {
          if (skippedDepth > 0) return;
          if (activeTextDepth > 0) append(text);
          else if (mathTextDepth > 0 && mathPropertiesDepth === 0) math.text(text);
        },
        onClose(_name, info) {
          ctx.budget.tick();
          const frame = frames.pop();
          if (!frame) return;
          if (frame.textElement) activeTextDepth--;
          if (frame.skipped) skippedDepth--;
          if (frame.mathProperties) mathPropertiesDepth--;
          if (frame.mathText) mathTextDepth--;
          if (frame.mathNode) {
            // A finished top-level `m:oMath` or `m:oMathPara` is the paragraph's text (DOC-11).
            const equation = math.close();
            if (equation !== undefined) append(equation);
          }
          if (frame.revision) {
            if (frame.revisionMarked) append(frame.revision === 'ins' ? '+]' : '-]', true);
            if (frame.revision === 'ins') insertedDepth--;
            else deletedDepth--;
          }
          if (frame.image && (frame.image.relationshipId !== undefined || frame.image.alt !== undefined)) {
            if (revisionVisible()) anchor(frame.image);
          }
          if (info.namespaceURI === WORD_NS && info.localName === 'p' && frame.paragraph) {
            const paragraph = paragraphs.pop();
            if (paragraph && !frame.skipped) finishParagraph(paragraph);
            // A field code ends within its paragraph; one still open is damaged and must not hide
            // the rest of the document. Its later `separate` or `end`, if any, only closes a result.
            if (fieldCodeDepth > 0) {
              fields.fill(false);
              fieldCodeDepth = 0;
            }
          }
          if (frame.flattenedTable) flattenedTables--;
          if (flattenedTables === 0 && frame.inBody && info.namespaceURI === WORD_NS) {
            const table = tables.at(-1);
            if (table && info.localName === 'tc') table.cell = undefined;
            else if (table && info.localName === 'tr') table.row = undefined;
          }
          if (frame.table) {
            tables.pop();
            const event: TableEvent = { table: layoutTable(frame.table, ctx.budget), loc: location(ctx) };
            const parent = tables.at(-1);
            if (parent) {
              const flattened = flattenTable(event.table.rows, ctx.budget);
              if (parent.cell && flattened.length > 0) {
                parent.cell.text += parent.cell.text.length > 0 ? `\n${flattened}` : flattened;
              }
              parent.nested.push(event, ...frame.table.nested);
            } else {
              if (frame.table.anchors.length > 0) event.anchors = frame.table.anchors;
              events.push(event, ...frame.table.nested);
            }
          }
        },
      },
      ctx,
    );
  } catch (error) {
    if (error !== STOP) throw error;
  }

  if (carry) {
    const last = carry;
    carry = undefined;
    // Nothing follows a removed final paragraph mark: keep the paragraph as it is.
    finishParagraph({ ...last, markDeleted: false, markInserted: false });
  }
  if (!rootSeen || !validRoot || !bodySeen) warnUnreadableRoot();
  if (hiddenSkipped)
    ctx.warnings.add({
      code: 'HIDDEN_CONTENT',
      message: 'Hidden text was left out; set includeHidden to keep it.',
    });
  if (emptyParagraphPending) events.push({ text: '', loc: location(ctx) });
  if (pendingAnchors.length > 0)
    events.push({ text: '', loc: location(ctx), anchors: pendingAnchors.splice(0) });
  hooks.beforeEmit?.();
  for (let index = 0; index < events.length; index++) {
    ctx.budget.tick();
    const next = events[index]!;
    events[index] = { text: '', loc: {} };
    if ('table' in next) {
      onTable?.();
      if (next.table.rows.length > 0 && !ctx.out.table(next.table.rows, next.table.headerRows, next.loc))
        break;
      if (next.anchors) onAnchors?.(next.anchors);
      continue;
    }
    const event = next;
    if (onParagraph?.(event) === true) continue;
    if (event.text.length === 0) {
      if (event.anchors) onAnchors?.(event.anchors);
      continue;
    }
    const level = event.level;
    const emitted =
      level !== undefined
        ? ctx.out.heading(level, event.text, event.loc)
        : ctx.options.runs
          ? ctx.out.paragraph(event.text, event.loc, event.runs)
          : ctx.out.paragraph(event.text, event.loc);
    if (!emitted) break;
    if (event.anchors) onAnchors?.(event.anchors);
  }
}

function builtinHeadingLevel(styleId: string | undefined): 1 | 2 | 3 | 4 | 5 | 6 | undefined {
  if (styleId === undefined) return undefined;
  const normalized = styleId.toLowerCase();
  if (normalized === 'title') return 1;
  for (let level = 1; level <= 6; level++) {
    if (normalized === `heading${level}`) return level as 1 | 2 | 3 | 4 | 5 | 6;
  }
  return undefined;
}

/** The `m:val` attribute of an Office Math property, whatever its prefix. */
function wordlessValue(
  attrs: Map<string, string>,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): string | undefined {
  return namespacedAttribute(attrs, 'val', MATH_NS, frames, current, budget);
}

function nearestRun(frames: readonly Frame[], budget: XmlContext['budget']): RunState | undefined {
  for (let index = frames.length - 1; index >= 0; index--) {
    budget.tick();
    const run = frames[index]?.run;
    if (run) return run;
  }
  return undefined;
}

function relationshipAttribute(
  attrs: Map<string, string>,
  localName: string,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== localName) continue;
    const prefix = qualifiedName.slice(0, colon);
    if (lookupNamespace(prefix, frames, current, budget) === REL_NS) return value;
  }
  return undefined;
}

function parseSpan(value: string | undefined, budget: XmlContext['budget']): number | undefined {
  if (value === undefined || value.length === 0 || value.length > 6) return undefined;
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    result = result * 10 + code - 48;
  }
  return result;
}

/**
 * Lay a Word table out on the model's grid: `rows[r][c]` is grid column `c`. Columns covered by a
 * `gridSpan` or a `vMerge` continuation hold empty cells, and a merge's first cell gets the span.
 */
function layoutTable(
  table: TableState,
  budget: XmlContext['budget'],
): { rows: Cell[][]; headerRows: number } {
  const rows: Cell[][] = [];
  const openMerges = new Map<number, Cell>();
  let headerRows = 0;
  let headerRun = true;
  for (const row of table.rows) {
    budget.tick();
    const cells: Cell[] = [];
    let column = 0;
    let stopped = false;
    for (const source of row.cells) {
      budget.tick();
      const span = source.colSpan;
      if (source.vMerge === 'continue' && openMerges.has(column)) {
        const top = openMerges.get(column)!;
        top.rowSpan = (top.rowSpan ?? 1) + 1;
      } else if (source.vMerge === 'restart') {
        openMerges.set(column, { text: '' });
      } else {
        for (let covered = column; covered < column + span; covered++) {
          budget.tick();
          openMerges.delete(covered);
        }
      }
      for (let offset = 0; offset < span; offset++) {
        budget.tick();
        if (!budget.addCells(1)) {
          stopped = true;
          break;
        }
        const isStart = offset === 0 && !(source.vMerge === 'continue' && openMerges.has(column));
        if (isStart) {
          const cell: Cell = source.vMerge === 'restart' ? openMerges.get(column)! : { text: '' };
          cell.text = source.text;
          if (span > 1) cell.colSpan = span;
          cells.push(cell);
        } else {
          cells.push({ text: '' });
        }
      }
      column += span;
      if (stopped) break;
    }
    if (cells.length > 0) {
      rows.push(cells);
      if (headerRun && row.header) headerRows++;
      else headerRun = false;
    }
    if (stopped) break;
  }
  return { rows, headerRows };
}

/** A nested table's text for its parent cell: tabs between cells, line breaks between rows. */
function flattenTable(rows: readonly Cell[][], budget: XmlContext['budget']): string {
  const lines: string[] = [];
  for (const row of rows) {
    budget.tick();
    const parts: string[] = [];
    for (const cell of row) {
      budget.tick();
      if (cell.text.length > 0) parts.push(cell.text);
    }
    if (parts.length > 0) lines.push(parts.join('\t'));
  }
  return lines.join('\n');
}

function emuToPixels(value: string | undefined, budget: XmlContext['budget']): number | undefined {
  // EMU values are non-negative integers; 12 digits covers any real page size.
  if (value === undefined || value.length === 0 || value.length > 12) return undefined;
  let emu = 0;
  for (let index = 0; index < value.length; index++) {
    budget.tick();
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return undefined;
    emu = emu * 10 + code - 48;
  }
  return emu === 0 ? undefined : Math.max(1, Math.round(emu / EMU_PER_PIXEL));
}

/** A VML style length (`96pt`, `2in`, `120px`) in pixels at 96 dpi. */
function vmlLength(style: string, property: string): number | undefined {
  const start = style.indexOf(`${property}:`);
  if (start < 0 || (start > 0 && style[start - 1] !== ';' && style[start - 1] !== ' ')) return undefined;
  let end = style.indexOf(';', start);
  if (end < 0) end = style.length;
  const value = style.slice(start + property.length + 1, end).trim();
  const unit = value.slice(-2);
  const number = Number(value.slice(0, -2));
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const factor =
    unit === 'pt'
      ? 96 / 72
      : unit === 'in'
        ? 96
        : unit === 'px'
          ? 1
          : unit === 'cm'
            ? 96 / 2.54
            : unit === 'mm'
              ? 96 / 25.4
              : 0;
  return factor > 0 ? Math.max(1, Math.round(number * factor)) : undefined;
}

/** Collect picture details from DrawingML (`wp:inline`, `wp:anchor`) and VML (`v:shape`) markup. */
function readImageElement(
  frame: Frame,
  parent: Frame | undefined,
  attrs: Map<string, string>,
  info: XmlElementInfo,
  frames: readonly Frame[],
  scope: Map<string, string>,
  budget: XmlContext['budget'],
): void {
  const local = info.localName;
  if (info.namespaceURI === WP_NS && (local === 'inline' || local === 'anchor')) {
    frame.image = { role: 'image' };
    return;
  }
  if (info.namespaceURI === VML_NS && local === 'shape') {
    frame.image = { role: 'image' };
    const alt = attrs.get('alt') ?? namespacedAttribute(attrs, 'title', OFFICE_NS, frames, scope, budget);
    if (alt !== undefined && alt.length > 0) frame.image.alt = alt;
    const style = attrs.get('style') ?? '';
    const width = vmlLength(style, 'width');
    const height = vmlLength(style, 'height');
    if (width !== undefined) frame.image.width = width;
    if (height !== undefined) frame.image.height = height;
    return;
  }
  let image: DocxImageRef | undefined;
  for (let index = frames.length - 1; index >= 0 && !image; index--) {
    budget.tick();
    image = frames[index]!.image;
  }
  if (!image) return;
  if (info.namespaceURI === WP_NS && local === 'extent' && parent?.image) {
    const width = emuToPixels(attrs.get('cx'), budget);
    const height = emuToPixels(attrs.get('cy'), budget);
    if (width !== undefined) image.width = width;
    if (height !== undefined) image.height = height;
  } else if (info.namespaceURI === WP_NS && local === 'docPr') {
    const alt = attrs.get('descr') || attrs.get('title');
    if (alt !== undefined && alt.length > 0) image.alt = alt;
  } else if (info.namespaceURI === A_NS && local === 'blip' && image.relationshipId === undefined) {
    const id =
      relationshipAttribute(attrs, 'embed', frames, scope, budget) ??
      relationshipAttribute(attrs, 'link', frames, scope, budget);
    if (id !== undefined) image.relationshipId = id;
  } else if (info.namespaceURI === VML_NS && local === 'imagedata' && image.relationshipId === undefined) {
    const id = relationshipAttribute(attrs, 'id', frames, scope, budget);
    if (id !== undefined) image.relationshipId = id;
    if (image.alt === undefined) {
      const title = namespacedAttribute(attrs, 'title', OFFICE_NS, frames, scope, budget);
      if (title !== undefined && title.length > 0) image.alt = title;
    }
  }
}

function namespacedAttribute(
  attrs: Map<string, string>,
  localName: string,
  namespace: string,
  frames: readonly Frame[],
  current: Map<string, string>,
  budget: XmlContext['budget'],
): string | undefined {
  for (const [qualifiedName, value] of attrs) {
    budget.tick();
    const colon = qualifiedName.indexOf(':');
    if (colon < 0 || qualifiedName.slice(colon + 1) !== localName) continue;
    if (lookupNamespace(qualifiedName.slice(0, colon), frames, current, budget) === namespace) return value;
  }
  return undefined;
}

import type { DocBuilder } from '../../core/builder.js';
import type { ResolvedOptions } from '../../core/options.js';
import type { ReadContext } from '../../core/reader.js';
import type { XmlContext, XmlElementInfo } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import type { DocxStyle } from './styles.js';

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
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
  loc: { path?: string };
}

/** Return `true` after emitting or consuming this paragraph to suppress default emission. */
export type DocxParagraphHandler = (paragraph: DocxParagraph) => boolean | void;

interface ParagraphState {
  text: string;
  runs: Array<{ text: string; bold?: boolean; italic?: boolean; href?: string }>;
  styleId?: string;
  numId?: string;
  ilvl?: number;
}

interface RunState {
  bold?: boolean;
  italic?: boolean;
}

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
}

interface BodyContext extends XmlContext {
  out: DocBuilder;
  options: Pick<ResolvedOptions, 'runs'>;
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
  onParagraph?: DocxParagraphHandler,
): void {
  const ctx = context as BodyContext;
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
  const events: DocxParagraph[] = [];

  const warnUnreadableRoot = (): void => {
    if (rootWarningSent) return;
    rootWarningSent = true;
    ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'The Word document body part could not be read.' });
  };

  const append = (text: string): void => {
    const paragraph = paragraphs.at(-1);
    if (text.length === 0 || outputStopped || !paragraph) return;
    ctx.budget.tick();
    if (!ctx.budget.checkOutputChars(stagedOutputChars + text.length)) {
      outputStopped = true;
      throw STOP;
    }
    stagedOutputChars += text.length;
    appendRun(paragraph, text, frames, ctx.options.runs, ctx.budget);
  };

  const finishParagraph = (paragraph: ParagraphState): void => {
    const baseLoc = location(ctx);
    const style = paragraph.styleId === undefined ? undefined : styles.get(paragraph.styleId);
    const level = style === undefined ? builtinHeadingLevel(paragraph.styleId) : style.level;
    const event: DocxParagraph = { text: paragraph.text, loc: baseLoc };
    if (paragraph.styleId !== undefined) event.styleId = paragraph.styleId;
    if (level !== undefined) event.level = level;
    if (paragraph.numId !== undefined) event.numId = paragraph.numId;
    if (paragraph.ilvl !== undefined) event.ilvl = paragraph.ilvl;
    if (ctx.options.runs) event.runs = cloneRuns(paragraph.runs, ctx.budget);
    if (paragraph.text.length === 0) {
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
            textElement: isWord && info.localName === 't',
            alternate,
            inBody,
            paragraphProperties: isWord && info.localName === 'pPr' && parent?.paragraph !== undefined,
            numberingProperties: isWord && info.localName === 'numPr' && parent?.paragraphProperties === true,
          };
          if (skipped) skippedDepth++;
          if (isWord && info.localName === 'p') {
            frame.paragraph = { text: '', runs: [] };
            paragraphs.push(frame.paragraph);
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
          if (!skipped && isWord && info.localName === 'pStyle' && parent?.paragraphProperties) {
            const paragraph = paragraphs.at(-1);
            const styleId = wordAttribute(attrs, 'val', frames, namespaceScope, ctx.budget);
            if (paragraph && styleId !== undefined) paragraph.styleId = styleId;
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
          if (!skipped && isWord && info.localName === 'tab') append('\t');
          if (!skipped && isWord && info.localName === 'br') append('\n');
          frames.push(frame);
          if (frame.textElement) activeTextDepth++;
        },
        onText(text) {
          if (activeTextDepth > 0 && skippedDepth === 0) append(text);
        },
        onClose(_name, info) {
          ctx.budget.tick();
          const frame = frames.pop();
          if (!frame) return;
          if (frame.textElement) activeTextDepth--;
          if (frame.skipped) skippedDepth--;
          if (info.namespaceURI === WORD_NS && info.localName === 'p' && frame.paragraph) {
            const paragraph = paragraphs.pop();
            if (paragraph && !frame.skipped) finishParagraph(paragraph);
          }
        },
      },
      ctx,
    );
  } catch (error) {
    if (error !== STOP) throw error;
  }

  if (!rootSeen || !validRoot || !bodySeen) warnUnreadableRoot();
  if (emptyParagraphPending) events.push({ text: '', loc: location(ctx) });
  for (let index = 0; index < events.length; index++) {
    ctx.budget.tick();
    const event = events[index]!;
    events[index] = { text: '', loc: {} };
    if (onParagraph?.(event) === true || event.text.length === 0) continue;
    const level = event.level;
    const emitted =
      level !== undefined
        ? ctx.out.heading(level, event.text, event.loc)
        : ctx.options.runs
          ? ctx.out.paragraph(event.text, event.loc, event.runs)
          : ctx.out.paragraph(event.text, event.loc);
    if (!emitted) break;
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

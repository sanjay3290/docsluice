import type { XmlContext } from '../../xml/index.js';
import { scanXml } from '../../xml/index.js';
import { namespaceScope, WORD_NS, wordAttribute } from './wordml.js';

const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
/** Footnote and endnote types that are layout separators, not notes. */
const SEPARATORS = new Set(['separator', 'continuationSeparator', 'continuationNotice']);

export interface DocxNoteText {
  text: string;
  author?: string;
}

interface StoryState {
  paragraphs: string[];
  paragraph: string;
}

/**
 * Collect visible text from a WordprocessingML story with bounded SAX events. Paragraphs become
 * lines; tabs and breaks are kept; `mc:Fallback` copies are skipped so text is not duplicated.
 * `onItem` receives each direct child of the root when `itemName` is set (notes, comments).
 */
function scanStory(
  input: Uint8Array | string,
  ctx: XmlContext,
  itemName: string | undefined,
  onItem: (attrs: (local: string) => string | undefined, state: StoryState) => void,
): void {
  const scopes: Map<string, string>[] = [];
  const names: Array<string | undefined> = [];
  let state: StoryState | undefined = itemName === undefined ? { paragraphs: [], paragraph: '' } : undefined;
  let itemAttrs: ((local: string) => string | undefined) | undefined;
  let textDepth = 0;
  let fallbackDepth = 0;
  let staged = 0;
  let stopped = false;
  const append = (text: string): void => {
    if (!state || stopped || fallbackDepth > 0 || text.length === 0) return;
    staged += text.length;
    // Stop staging once the shared output allowance is spent; the builder reports truncation.
    if (!ctx.budget.checkOutputChars(staged)) {
      stopped = true;
      return;
    }
    state.paragraph += text;
  };
  scanXml(
    input,
    {
      onOpen(_name, attrs, info) {
        ctx.budget.tick();
        scopes.push(namespaceScope(attrs, ctx.budget));
        const word = info.namespaceURI === WORD_NS ? info.localName : undefined;
        if (info.namespaceURI === MC_NS && info.localName === 'Fallback') fallbackDepth++;
        if (itemName !== undefined && names.length === 1 && word === itemName) {
          const captured = new Map(attrs);
          const capturedScopes = [...scopes];
          itemAttrs = (local) => wordAttribute(captured, local, capturedScopes, ctx.budget);
          state = { paragraphs: [], paragraph: '' };
        }
        if (word === 't') textDepth++;
        else if (word === 'tab') append('\t');
        else if (word === 'br' || word === 'cr') append('\n');
        names.push(word);
      },
      onText(text) {
        if (textDepth > 0) append(text);
      },
      onClose(_name, info) {
        ctx.budget.tick();
        scopes.pop();
        const word = names.pop();
        if (info.namespaceURI === MC_NS && info.localName === 'Fallback') fallbackDepth--;
        if (word === 't') textDepth--;
        else if (word === 'p' && state) {
          state.paragraphs.push(state.paragraph);
          state.paragraph = '';
        }
        if (itemName !== undefined && names.length === 1 && word === itemName && state && itemAttrs) {
          onItem(itemAttrs, state);
          state = undefined;
          itemAttrs = undefined;
        }
      },
    },
    ctx,
  );
  if (itemName === undefined && state) onItem(() => undefined, state);
}

function storyText(state: StoryState): string {
  const lines = state.paragraph.length > 0 ? [...state.paragraphs, state.paragraph] : state.paragraphs;
  return lines.join('\n').trim();
}

/** The text of a header or footer part. */
export function readDocxStoryText(input: Uint8Array | string, ctx: XmlContext): string {
  let text = '';
  scanStory(input, ctx, undefined, (_attrs, state) => {
    text = storyText(state);
  });
  return text;
}

/**
 * Notes from `footnotes.xml`, `endnotes.xml` or `comments.xml`, keyed by `w:id` in a `Map`.
 * Separator footnotes and endnotes are skipped; comments keep `w:author` (or `w:initials`).
 */
export function readDocxNotes(
  input: Uint8Array | string,
  ctx: XmlContext,
  kind: 'footnote' | 'endnote' | 'comment',
): Map<string, DocxNoteText> {
  const notes = new Map<string, DocxNoteText>();
  scanStory(input, ctx, kind, (attrs, state) => {
    const id = attrs('id');
    const type = attrs('type');
    if (id === undefined || notes.has(id) || (type !== undefined && SEPARATORS.has(type))) return;
    const text = storyText(state);
    if (text.length === 0) return;
    const note: DocxNoteText = { text };
    const author = kind === 'comment' ? (attrs('author') ?? attrs('initials')) : undefined;
    if (author !== undefined && author.length > 0) note.author = author;
    notes.set(id, note);
  });
  return notes;
}

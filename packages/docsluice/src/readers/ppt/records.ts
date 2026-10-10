import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import type { WarningSink } from '../../core/warnings.js';

// Record types from [MS-PPT] 2.13.24 (RecordType).
const RT_DOCUMENT = 0x03e8;
const RT_SLIDE = 0x03ee;
const RT_NOTES = 0x03f0;
const RT_NOTES_ATOM = 0x03f1;
const RT_SLIDE_PERSIST_ATOM = 0x03f3;
const RT_OUTLINE_TEXT_REF_ATOM = 0x0f9e;
const RT_TEXT_HEADER_ATOM = 0x0f9f;
const RT_TEXT_CHARS_ATOM = 0x0fa0;
const RT_TEXT_BYTES_ATOM = 0x0fa8;
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0;
const RT_USER_EDIT_ATOM = 0x0ff5;
const RT_CURRENT_USER_ATOM = 0x0ff6;
const RT_PERSIST_DIRECTORY_ATOM = 0x1772;
const RT_OE_PLACEHOLDER_ATOM = 0x0bc3;
const RT_SP_CONTAINER = 0xf004;
const RT_CLIENT_DATA = 0xf011;
const RT_CLIENT_TEXTBOX = 0xf00d;
/** CurrentUserAtom header tokens ([MS-PPT] 2.3.2): plain, and encrypted with RC4 CryptoAPI. */
const TOKEN_PLAIN = 0xe391c05f;
const TOKEN_ENCRYPTED = 0xf3d1c4df;
/** SlideListWithTextContainer instances ([MS-PPT] 2.4.14.3). */
const LIST_SLIDES = 0;
const LIST_NOTES = 2;
/** TextHeaderAtom text types ([MS-PPT] 2.13.33): Title, Body, Notes, Other, CenterBody, CenterTitle. */
export const TEXT_TITLE = 0;
export const TEXT_NOTES = 2;
export const TEXT_CENTER_TITLE = 6;

/** PlaceholderEnum ([MS-PPT] 2.13.21) values that hold a title: master and slide, plain, centered, vertical. */
const TITLE_PLACEHOLDERS: ReadonlySet<number> = new Set([0x01, 0x03, 0x0d, 0x0f, 0x11]);
/** Notes body placeholders (master and notes slide). */
const NOTES_PLACEHOLDERS: ReadonlySet<number> = new Set([0x06, 0x0c]);
/** Placeholders with generated or no text: slide images, date, slide number, footer, header. */
const SKIPPED_PLACEHOLDERS: ReadonlySet<number> = new Set([0x05, 0x07, 0x08, 0x09, 0x0a, 0x0b]);

/** One text block: its text type ([MS-PPT] TextTypeEnum, or from its placeholder) and paragraphs. */
export interface PptText {
  type: number;
  /** The shape is a placeholder (`OEPlaceholderAtom`). */
  placeholder?: boolean;
  paragraphs: string[];
}

export interface PptSlide {
  /** Placeholder text from the slide list, then text boxes from the slide drawing, in tree order. */
  texts: PptText[];
  notes: string[];
}

export interface PptPresentation {
  slides: PptSlide[];
  depthLimited: boolean;
}

interface Header {
  start: number;
  body: number;
  end: number;
  container: boolean;
  instance: number;
  type: number;
}

/** A record header at `offset` whose body fits inside `boundary`, or undefined. */
function header(view: DataView, offset: number, boundary: number): Header | undefined {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > boundary) return undefined;
  const versionInstance = view.getUint16(offset, true);
  const length = view.getUint32(offset + 4, true);
  const end = offset + 8 + length;
  if (end > boundary) return undefined;
  return {
    start: offset,
    body: offset + 8,
    end,
    container: (versionInstance & 0x0f) === 0x0f,
    instance: versionInstance >>> 4,
    type: view.getUint16(offset + 2, true),
  };
}

/** The direct children of a container; stops at the first record that does not fit. */
function children(view: DataView, parent: Header, budget: Budget): Header[] {
  const result: Header[] = [];
  let cursor = parent.body;
  while (cursor < parent.end) {
    budget.tick();
    const child = header(view, cursor, parent.end);
    if (!child) break;
    result.push(child);
    cursor = child.end;
  }
  return result;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The PowerPoint Document stream is malformed.');
}

/** The offset of the current UserEditAtom, from the Current User stream ([MS-PPT] 2.3.2). */
function currentEditOffset(stream: Uint8Array): number {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  const record = header(view, 0, stream.length);
  if (!record || record.type !== RT_CURRENT_USER_ATOM || record.end - record.body < 12) throw corrupt();
  const token = view.getUint32(record.body + 4, true);
  if (token === TOKEN_ENCRYPTED) throw new EncryptedError('unsupported-encryption');
  if (token !== TOKEN_PLAIN) throw corrupt();
  return view.getUint32(record.body + 8, true);
}

/**
 * The live persist object directory: walk the UserEditAtom chain from the current edit back to the
 * first save, keeping the newest offset for each persist id ([MS-PPT] 2.1.2). Each step must move
 * to an earlier offset, so the walk ends.
 */
function persistDirectory(
  view: DataView,
  firstEdit: number,
  budget: Budget,
): { objects: Map<number, number>; documentId: number } {
  const objects = new Map<number, number>();
  let documentId: number | undefined;
  let edit = firstEdit;
  for (;;) {
    budget.tick();
    const atom = header(view, edit, view.byteLength);
    if (!atom || atom.type !== RT_USER_EDIT_ATOM || atom.end - atom.body < 28) throw corrupt();
    // A UserEditAtom with encryptSessionPersistIdRef belongs to an encrypted document.
    if (atom.end - atom.body >= 32 && documentId === undefined) {
      throw new EncryptedError('unsupported-encryption');
    }
    const lastEdit = view.getUint32(atom.body + 8, true);
    documentId ??= view.getUint32(atom.body + 16, true);
    const directory = header(view, view.getUint32(atom.body + 12, true), view.byteLength);
    if (!directory || directory.type !== RT_PERSIST_DIRECTORY_ATOM) throw corrupt();
    let cursor = directory.body;
    while (cursor + 4 <= directory.end) {
      budget.tick();
      const entry = view.getUint32(cursor, true);
      const first = entry & 0x000f_ffff;
      const count = entry >>> 20;
      cursor += 4;
      for (let index = 0; index < count && cursor + 4 <= directory.end; index++) {
        budget.tick();
        const id = first + index;
        if (!objects.has(id)) objects.set(id, view.getUint32(cursor, true));
        cursor += 4;
      }
    }
    if (lastEdit === 0) break;
    if (lastEdit >= edit) throw corrupt();
    edit = lastEdit;
  }
  return { objects, documentId: documentId ?? 0 };
}

/** Text atom contents: UTF-16LE for TextCharsAtom, the low bytes of UTF-16 for TextBytesAtom. */
function decodeText(bytes: Uint8Array, record: Header, budget: Budget): string {
  const body = bytes.subarray(record.body, record.end);
  if (record.type === RT_TEXT_CHARS_ATOM) {
    budget.tick();
    return new TextDecoder('utf-16le').decode(body.subarray(0, body.length & ~1));
  }
  const chunks: string[] = [];
  for (let offset = 0; offset < body.length; offset += 4096) {
    budget.tick();
    chunks.push(String.fromCharCode(...body.subarray(offset, offset + 4096)));
  }
  return chunks.join('');
}

/** Paragraphs end with CR; a vertical tab is a line break inside one ([MS-PPT] 2.9.x TextCharsAtom). */
function paragraphs(text: string, budget: Budget): string[] {
  const result: string[] = [];
  let start = 0;
  while (start <= text.length) {
    budget.tick();
    let end = text.indexOf('\r', start);
    if (end < 0) end = text.length;
    result.push(text.slice(start, end).replaceAll('\v', '\n'));
    start = end + 1;
  }
  return result;
}

/** Text atoms after TextHeaderAtoms in a list of sibling records (slide list or client text box). */
function collectTexts(bytes: Uint8Array, view: DataView, records: Header[], budget: Budget): PptText[] {
  const texts: PptText[] = [];
  let type: number | undefined;
  for (const record of records) {
    budget.tick();
    if (record.type === RT_TEXT_HEADER_ATOM) {
      type = record.end - record.body >= 4 ? view.getUint32(record.body, true) : undefined;
    } else if (
      (record.type === RT_TEXT_CHARS_ATOM || record.type === RT_TEXT_BYTES_ATOM) &&
      type !== undefined
    ) {
      texts.push({ type, paragraphs: paragraphs(decodeText(bytes, record, budget), budget) });
      type = undefined;
    } else if (record.type === RT_SLIDE_PERSIST_ATOM) {
      type = undefined;
    }
  }
  return texts;
}

/** The PlaceholderEnum value of a shape (`OfficeArtClientData` > `OEPlaceholderAtom`), if any. */
function placeholderOf(view: DataView, kids: Header[], budget: Budget): number | undefined {
  for (const kid of kids) {
    budget.tick();
    if (kid.type !== RT_CLIENT_DATA) continue;
    for (const atom of children(view, kid, budget)) {
      budget.tick();
      if (atom.type === RT_OE_PLACEHOLDER_ATOM && atom.end - atom.body >= 5)
        return view.getUint8(atom.body + 4);
    }
  }
  return undefined;
}

/**
 * Text boxes of a slide or notes drawing (`OfficeArtClientTextbox` in a shape), in tree order. A
 * title or notes placeholder sets the text type; date, number, footer, header and image
 * placeholders are skipped. Boxes that hold an OutlineTextRefAtom point at slide-list text that
 * is already read. Containers nested deeper than `maxDepth` are not entered. An explicit stack
 * replaces recursion (SEC-8).
 */
function drawingTexts(
  bytes: Uint8Array,
  view: DataView,
  root: Header,
  budget: Budget,
  maxDepth: number,
): { texts: PptText[]; depthLimited: boolean } {
  const texts: PptText[] = [];
  let depthLimited = false;
  const stack: Array<{ record: Header; depth: number }> = [{ record: root, depth: 0 }];
  while (stack.length > 0) {
    budget.tick();
    const { record, depth } = stack.pop()!;
    const kids = children(view, record, budget);
    const textbox =
      record.type === RT_SP_CONTAINER ? kids.find((kid) => kid.type === RT_CLIENT_TEXTBOX) : undefined;
    if (textbox) {
      const placeholder = placeholderOf(view, kids, budget);
      if (placeholder !== undefined && SKIPPED_PLACEHOLDERS.has(placeholder)) continue;
      const boxKids = children(view, textbox, budget);
      if (boxKids.some((kid) => kid.type === RT_OUTLINE_TEXT_REF_ATOM)) continue;
      for (const text of collectTexts(bytes, view, boxKids, budget)) {
        budget.tick();
        if (placeholder !== undefined) {
          text.placeholder = true;
          if (TITLE_PLACEHOLDERS.has(placeholder)) text.type = TEXT_TITLE;
          else if (NOTES_PLACEHOLDERS.has(placeholder)) text.type = TEXT_NOTES;
        }
        texts.push(text);
      }
      continue;
    }
    for (let index = kids.length - 1; index >= 0; index--) {
      budget.tick();
      const kid = kids[index]!;
      if (!kid.container) continue;
      if (depth + 1 > maxDepth) {
        depthLimited = true;
        continue;
      }
      stack.push({ record: kid, depth: depth + 1 });
    }
  }
  return { texts, depthLimited };
}

interface ListEntry {
  persistId: number;
  slideId: number;
  texts: PptText[];
}

/** SlidePersistAtoms of a slide list, each with the text records that follow it. */
function listEntries(bytes: Uint8Array, view: DataView, list: Header, budget: Budget): ListEntry[] {
  const entries: ListEntry[] = [];
  let records: Header[] = [];
  let current: { persistId: number; slideId: number } | undefined;
  const flush = (): void => {
    if (current) entries.push({ ...current, texts: collectTexts(bytes, view, records, budget) });
    records = [];
  };
  for (const record of children(view, list, budget)) {
    budget.tick();
    if (record.type === RT_SLIDE_PERSIST_ATOM) {
      flush();
      current =
        record.end - record.body >= 16
          ? { persistId: view.getUint32(record.body, true), slideId: view.getUint32(record.body + 12, true) }
          : undefined;
      continue;
    }
    records.push(record);
  }
  flush();
  return entries;
}

/**
 * Read the live slides of a PowerPoint 97-2003 `PowerPoint Document` stream ([MS-PPT] 2.1): slides
 * in slide-list order with their placeholder text and text boxes, and their notes. A slide or notes
 * part that cannot be found keeps the text read elsewhere and adds one `UNREADABLE_PART`.
 */
export function parsePresentation(
  document: Uint8Array,
  currentUser: Uint8Array,
  budget: Budget,
  warnings: WarningSink,
): PptPresentation {
  const view = new DataView(document.buffer, document.byteOffset, document.byteLength);
  const { objects, documentId } = persistDirectory(view, currentEditOffset(currentUser), budget);
  const documentRecord = header(view, objects.get(documentId) ?? -1, document.length);
  if (!documentRecord || documentRecord.type !== RT_DOCUMENT) throw corrupt();
  let slideList: Header | undefined;
  let notesList: Header | undefined;
  for (const child of children(view, documentRecord, budget)) {
    budget.tick();
    if (child.type !== RT_SLIDE_LIST_WITH_TEXT) continue;
    if (child.instance === LIST_SLIDES) slideList ??= child;
    else if (child.instance === LIST_NOTES) notesList ??= child;
  }

  let unreadable = 0;
  let depthLimited = false;
  const maxDepth = budget.limits.blockDepth;
  const slides: PptSlide[] = [];
  const bySlideId = new Map<number, PptSlide>();
  for (const entry of slideList ? listEntries(document, view, slideList, budget) : []) {
    budget.tick();
    const slide: PptSlide = { texts: entry.texts, notes: [] };
    slides.push(slide);
    if (!bySlideId.has(entry.slideId)) bySlideId.set(entry.slideId, slide);
    const container = header(view, objects.get(entry.persistId) ?? -1, document.length);
    if (!container || container.type !== RT_SLIDE) {
      unreadable++;
      continue;
    }
    const drawing = drawingTexts(document, view, container, budget, maxDepth);
    depthLimited ||= drawing.depthLimited;
    for (const text of drawing.texts) {
      budget.tick();
      slide.texts.push(text);
    }
  }

  for (const entry of notesList ? listEntries(document, view, notesList, budget) : []) {
    budget.tick();
    const container = header(view, objects.get(entry.persistId) ?? -1, document.length);
    if (!container || container.type !== RT_NOTES) {
      unreadable++;
      continue;
    }
    const kids = children(view, container, budget);
    const atom = kids.find((kid) => kid.type === RT_NOTES_ATOM && kid.end - kid.body >= 4);
    const slide = atom ? bySlideId.get(view.getUint32(atom.body, true)) : undefined;
    if (!slide) continue;
    const drawing = drawingTexts(document, view, container, budget, maxDepth);
    depthLimited ||= drawing.depthLimited;
    for (const text of [...entry.texts, ...drawing.texts]) {
      // The notes body, and text boxes that are not placeholders (as in PPTX, PPT-4).
      if (text.type !== TEXT_NOTES && (text.placeholder === true || text.type === TEXT_TITLE)) continue;
      for (const paragraph of text.paragraphs) {
        budget.tick();
        slide.notes.push(paragraph);
      }
    }
  }
  if (unreadable > 0) {
    warnings.add({
      code: 'UNREADABLE_PART',
      message: `${unreadable} slide or notes records could not be found; their placeholder text is kept.`,
    });
  }
  return { slides, depthLimited };
}

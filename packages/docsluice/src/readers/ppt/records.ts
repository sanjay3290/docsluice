import { CorruptFileError, EncryptedError, LimitExceededError } from '../../core/errors.js';
import type { Budget } from '../../core/budget.js';

const RT_DOCUMENT = 0x03e8;
const RT_SLIDE = 0x03ee;
const RT_NOTES = 0x03f0;
const RT_NOTES_ATOM = 0x03f1;
const RT_SLIDE_PERSIST = 0x03f3;
const RT_OUTLINE_TEXT_REF = 0x0f9e;
const RT_TEXT_HEADER = 0x0f9f;
const RT_TEXT_CHARS = 0x0fa0;
const RT_TEXT_BYTES = 0x0fa8;
const RT_SLIDE_LIST_WITH_TEXT = 0x0ff0;
const RT_USER_EDIT = 0x0ff5;
const RT_CURRENT_USER = 0x0ff6;
const RT_PERSIST_DIRECTORY = 0x1772;
const RT_CLIENT_TEXTBOX = 0xf00d;
const CURRENT_USER_TOKEN = 0xe391c05f;
const ENCRYPTED_USER_TOKEN = 0xf3d1c4df;
const MAX_PERSIST_ID = 0x0ffffe;
const MAX_PPT_OBJECTS = 100_000;

interface RecordHeader {
  start: number;
  payloadStart: number;
  end: number;
  version: number;
  instance: number;
  type: number;
  parentStart: number;
}

export interface PptText {
  type: number;
  text: string;
}

export interface PptSlide {
  id: number;
  texts: PptText[];
  notes: string[];
}

interface SlideWork {
  persistId: number;
  slide: PptSlide;
}

interface TextStage {
  chars: number;
  stopped: boolean;
}

interface ParserState {
  retainedObjects: number;
  warnedUnreadable: boolean;
}

function reserveObjects(state: ParserState, count = 1): void {
  if (count < 0 || state.retainedObjects > MAX_PPT_OBJECTS - count) {
    throw new LimitExceededError('pptObjects', MAX_PPT_OBJECTS);
  }
  state.retainedObjects += count;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The PowerPoint presentation stream is malformed.');
}

function unreadable(state: ParserState, budget: Budget): void {
  if (state.warnedUnreadable) return;
  state.warnedUnreadable = true;
  reserveObjects(state);
  budget.warnings.add({
    code: 'UNREADABLE_PART',
    message: 'Malformed PowerPoint slide or notes records were skipped.',
  });
}

function readRecord(
  bytes: Uint8Array,
  offset: number,
  boundary = bytes.length,
  parentStart = -1,
): RecordHeader {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > boundary || boundary > bytes.length) {
    throw corrupt();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionInstance = view.getUint16(offset, true);
  const length = view.getUint32(offset + 4, true);
  const payloadStart = offset + 8;
  const end = payloadStart + length;
  if (end > boundary || end < payloadStart) throw corrupt();
  return {
    start: offset,
    payloadStart,
    end,
    version: versionInstance & 0x0f,
    instance: versionInstance >>> 4,
    type: view.getUint16(offset + 2, true),
    parentStart,
  };
}

function* readDirectChildren(
  bytes: Uint8Array,
  parent: RecordHeader,
  budget: Budget,
): IterableIterator<RecordHeader> {
  if (parent.version !== 0x0f) throw corrupt();
  let cursor = parent.payloadStart;
  while (cursor < parent.end) {
    budget.tick();
    const child = readRecord(bytes, cursor, parent.end, parent.start);
    if (child.end <= cursor) throw corrupt();
    cursor = child.end;
    yield child;
  }
  if (cursor !== parent.end) throw corrupt();
}

function enterBlockDepth(budget: Budget): boolean {
  let entered: boolean;
  try {
    entered = budget.enterDepth('block');
  } catch (error) {
    budget.exitDepth('block');
    throw error;
  }
  if (!entered) {
    budget.exitDepth('block');
    return false;
  }
  return true;
}

function* walkChildren(
  bytes: Uint8Array,
  root: RecordHeader,
  budget: Budget,
  state: ParserState,
): IterableIterator<RecordHeader> {
  interface Frame {
    cursor: number;
    end: number;
    parentStart: number;
    entered: boolean;
  }
  reserveObjects(state);
  const stack: Frame[] = [];
  // The root frame and its generator state are both retained before entering depth.
  reserveObjects(state, 2);
  if (!enterBlockDepth(budget)) return;
  stack.push({ cursor: root.payloadStart, end: root.end, parentStart: root.start, entered: true });
  try {
    while (stack.length > 0) {
      budget.tick();
      const frame = stack[stack.length - 1]!;
      if (frame.cursor === frame.end) {
        stack.pop();
        if (frame.entered) budget.exitDepth('block');
        continue;
      }
      const child = readRecord(bytes, frame.cursor, frame.end, frame.parentStart);
      if (child.end <= frame.cursor) throw corrupt();
      frame.cursor = child.end;
      yield child;
      if (child.version === 0x0f) {
        reserveObjects(state, 3);
        if (!enterBlockDepth(budget)) continue;
        stack.push({ cursor: child.payloadStart, end: child.end, parentStart: child.start, entered: true });
      }
    }
  } finally {
    while (stack.length > 0) {
      const frame = stack.pop()!;
      if (frame.entered) budget.exitDepth('block');
    }
  }
}

function parseCurrentUser(bytes: Uint8Array): number {
  const record = readRecord(bytes, 0);
  if (record.type !== RT_CURRENT_USER || record.version !== 0 || record.instance !== 0) throw corrupt();
  if (record.end !== bytes.length || record.end - record.payloadStart < 24) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fixedSize = view.getUint32(record.payloadStart, true);
  if (fixedSize !== 20) throw corrupt();
  const token = view.getUint32(record.payloadStart + 4, true);
  if (token === ENCRYPTED_USER_TOKEN) throw new EncryptedError('unsupported-encryption');
  if (token !== CURRENT_USER_TOKEN) throw corrupt();
  const currentEditOffset = view.getUint32(record.payloadStart + 8, true);
  const usernameLength = view.getUint16(record.payloadStart + 12, true);
  if (usernameLength > 255) throw corrupt();
  const relVersionOffset = record.payloadStart + 20 + usernameLength;
  if (relVersionOffset + 4 > record.end) throw corrupt();
  const remaining = record.end - (relVersionOffset + 4);
  if (remaining !== 0 && remaining !== usernameLength * 2) throw corrupt();
  return currentEditOffset;
}

interface UserEdit {
  offsetLastEdit: number;
  offsetPersistDirectory: number;
  docPersistIdRef: number;
}

function parseUserEdit(bytes: Uint8Array, offset: number): UserEdit {
  const record = readRecord(bytes, offset);
  const length = record.end - record.payloadStart;
  if (
    record.type !== RT_USER_EDIT ||
    record.version !== 0 ||
    record.instance !== 0 ||
    (length !== 28 && length !== 32)
  ) {
    throw corrupt();
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    offsetLastEdit: view.getUint32(record.payloadStart + 8, true),
    offsetPersistDirectory: view.getUint32(record.payloadStart + 12, true),
    docPersistIdRef: view.getUint32(record.payloadStart + 16, true),
  };
}

function parsePersistDirectory(
  bytes: Uint8Array,
  offset: number,
  offsetLastEdit: number,
  offsetCurrentEdit: number,
  budget: Budget,
  state: ParserState,
): Map<number, number> {
  const record = readRecord(bytes, offset, offsetCurrentEdit);
  if (record.type !== RT_PERSIST_DIRECTORY || record.version !== 0 || record.instance !== 0) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  reserveObjects(state);
  const directory = new Map<number, number>();
  let cursor = record.payloadStart;
  while (cursor < record.end) {
    budget.tick();
    if (cursor + 4 > record.end) throw corrupt();
    const header = view.getUint32(cursor, true);
    const persistId = header & 0x000f_ffff;
    const count = header >>> 20;
    cursor += 4;
    if (count === 0 || persistId > MAX_PERSIST_ID || persistId + count - 1 > MAX_PERSIST_ID) throw corrupt();
    if (count > Math.floor((record.end - cursor) / 4)) throw corrupt();
    for (let index = 0; index < count; index++) {
      budget.tick();
      const objectOffset = view.getUint32(cursor, true);
      cursor += 4;
      const id = persistId + index;
      if (
        directory.has(id) ||
        objectOffset < offsetLastEdit ||
        objectOffset >= offset ||
        objectOffset >= bytes.length
      ) {
        throw corrupt();
      }
      reserveObjects(state);
      directory.set(id, objectOffset);
    }
  }
  if (cursor !== record.end) throw corrupt();
  return directory;
}

function buildPersistMap(
  bytes: Uint8Array,
  currentEditOffset: number,
  budget: Budget,
  state: ParserState,
): Map<number, number> {
  reserveObjects(state);
  const persist = new Map<number, number>();
  let editOffset = currentEditOffset;
  while (true) {
    budget.tick();
    reserveObjects(state);
    const edit = parseUserEdit(bytes, editOffset);
    if (
      edit.docPersistIdRef !== 1 ||
      edit.offsetPersistDirectory <= edit.offsetLastEdit ||
      edit.offsetPersistDirectory >= editOffset
    ) {
      throw corrupt();
    }
    if (edit.offsetLastEdit !== 0 && edit.offsetLastEdit >= editOffset) throw corrupt();
    const latestForEdit = parsePersistDirectory(
      bytes,
      edit.offsetPersistDirectory,
      edit.offsetLastEdit,
      editOffset,
      budget,
      state,
    );
    for (const [id, offset] of latestForEdit) {
      budget.tick();
      if (!persist.has(id)) {
        reserveObjects(state);
        persist.set(id, offset);
      }
    }
    if (edit.offsetLastEdit === 0) break;
    editOffset = edit.offsetLastEdit;
  }
  if (!persist.has(1)) throw corrupt();
  return persist;
}

function bytesRange(bytes: Uint8Array, record: RecordHeader): Uint8Array {
  return bytes.subarray(record.payloadStart, record.end);
}

function decodeText(
  bytes: Uint8Array,
  record: RecordHeader,
  budget: Budget,
  stage: TextStage,
): string | undefined {
  const length = record.end - record.payloadStart;
  if (record.type === RT_TEXT_CHARS && (length & 1) !== 0) throw corrupt();
  const charCount = record.type === RT_TEXT_CHARS ? length / 2 : length;
  if (!budget.checkOutputChars(stage.chars + charCount)) {
    stage.stopped = true;
    return undefined;
  }
  budget.tick();
  const data = bytesRange(bytes, record);
  let text: string;
  if (record.type === RT_TEXT_CHARS) {
    try {
      text = new TextDecoder('utf-16le', { fatal: true }).decode(data);
    } catch {
      throw corrupt();
    }
  } else {
    const chunks: string[] = [];
    const chunkSize = 8192;
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      budget.tick();
      const codes: number[] = [];
      const end = Math.min(data.length, offset + chunkSize);
      for (let index = offset; index < end; index++) {
        budget.tick();
        codes.push(data[index]!);
      }
      chunks.push(String.fromCharCode(...codes));
    }
    text = chunks.join('');
  }
  stage.chars += charCount;
  return text.replaceAll('\r', '\n');
}

function hasOutlineReference(bytes: Uint8Array, textbox: RecordHeader, budget: Budget): boolean {
  let found = false;
  for (const child of readDirectChildren(bytes, textbox, budget)) {
    budget.tick();
    if (child.type === RT_OUTLINE_TEXT_REF) found = true;
  }
  return found;
}

function addTextFromTextbox(
  bytes: Uint8Array,
  textbox: RecordHeader,
  budget: Budget,
  state: ParserState,
  stage: TextStage,
  output: PptText[],
  requiredType?: number,
): void {
  let activeType: number | undefined;
  for (const record of readDirectChildren(bytes, textbox, budget)) {
    budget.tick();
    if (record.type === RT_TEXT_HEADER) {
      activeType = undefined;
      if (record.version !== 0 || record.end - record.payloadStart !== 4) throw corrupt();
      const textType = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        record.payloadStart,
        true,
      );
      if (requiredType === undefined || textType === requiredType) activeType = textType;
      continue;
    }
    if ((record.type === RT_TEXT_CHARS || record.type === RT_TEXT_BYTES) && activeType !== undefined) {
      if (record.end > record.payloadStart) reserveObjects(state, 3);
      const text = decodeText(bytes, record, budget, stage);
      if (stage.stopped) return;
      if (text !== undefined && text.length > 0) output.push({ type: activeType, text });
      activeType = undefined;
    }
  }
}

function parseDocumentChildren(
  bytes: Uint8Array,
  document: RecordHeader,
  budget: Budget,
): {
  slideList?: RecordHeader;
  notesList?: RecordHeader;
} {
  if (document.type !== RT_DOCUMENT || document.version !== 0x0f) throw corrupt();
  let slideList: RecordHeader | undefined;
  let notesList: RecordHeader | undefined;
  for (const child of readDirectChildren(bytes, document, budget)) {
    budget.tick();
    if (child.type !== RT_SLIDE_LIST_WITH_TEXT || child.version !== 0x0f) continue;
    if (child.instance === 0) slideList ??= child;
    if (child.instance === 2) notesList ??= child;
  }
  if (slideList === undefined) throw corrupt();
  return { slideList, notesList };
}

function parseSlideList(
  bytes: Uint8Array,
  slideList: RecordHeader,
  budget: Budget,
  state: ParserState,
  stage: TextStage,
): SlideWork[] {
  reserveObjects(state, 2);
  const slides: SlideWork[] = [];
  let current: SlideWork | undefined;
  let activeType: number | undefined;
  const seenIds = new Set<number>();
  try {
    for (const child of readDirectChildren(bytes, slideList, budget)) {
      budget.tick();
      if (child.type === RT_SLIDE_PERSIST) {
        activeType = undefined;
        if (child.version !== 0 || child.end - child.payloadStart !== 20) {
          unreadable(state, budget);
          current = undefined;
          continue;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const persistId = view.getUint32(child.payloadStart, true);
        const textCount = view.getInt32(child.payloadStart + 8, true);
        const slideId = view.getUint32(child.payloadStart + 12, true);
        if (textCount < 0 || textCount > 8 || slideId < 0x100 || slideId > 0x7fff_ffff) {
          unreadable(state, budget);
          current = undefined;
          continue;
        }
        if (seenIds.has(slideId)) {
          unreadable(state, budget);
          current = undefined;
          continue;
        }
        reserveObjects(state, 6);
        seenIds.add(slideId);
        current = { persistId, slide: { id: slideId, texts: [], notes: [] } };
        slides.push(current);
        continue;
      }
      if (child.type === RT_TEXT_HEADER) {
        activeType = undefined;
        if (current === undefined || child.version !== 0 || child.end - child.payloadStart !== 4) {
          if (current !== undefined) unreadable(state, budget);
          continue;
        }
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        activeType = view.getUint32(child.payloadStart, true);
        continue;
      }
      if (
        (child.type === RT_TEXT_CHARS || child.type === RT_TEXT_BYTES) &&
        current !== undefined &&
        activeType !== undefined
      ) {
        try {
          if (child.end > child.payloadStart) reserveObjects(state, 3);
          const text = decodeText(bytes, child, budget, stage);
          if (stage.stopped) break;
          if (text !== undefined && text.length > 0) current.slide.texts.push({ type: activeType, text });
        } catch (error) {
          if (!(error instanceof CorruptFileError)) throw error;
          unreadable(state, budget);
        }
        activeType = undefined;
      }
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    unreadable(state, budget);
  }
  return slides;
}

function parseInlineSlideText(
  bytes: Uint8Array,
  container: RecordHeader,
  budget: Budget,
  state: ParserState,
  stage: TextStage,
): PptText[] {
  if (container.type !== RT_SLIDE || container.version !== 0x0f) throw corrupt();
  reserveObjects(state);
  const text: PptText[] = [];
  try {
    for (const record of walkChildren(bytes, container, budget, state)) {
      budget.tick();
      if (record.type !== RT_CLIENT_TEXTBOX || record.version !== 0x0f) continue;
      if (hasOutlineReference(bytes, record, budget)) continue;
      addTextFromTextbox(bytes, record, budget, state, stage, text);
      if (stage.stopped) break;
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    unreadable(state, budget);
  }
  return text;
}

function parseNotesContainer(
  bytes: Uint8Array,
  container: RecordHeader,
  slideIndexes: Map<number, number>,
  slides: SlideWork[],
  budget: Budget,
  state: ParserState,
  stage: TextStage,
): void {
  if (container.type !== RT_NOTES || container.version !== 0x0f) throw corrupt();
  let atom: RecordHeader | undefined;
  for (const candidate of readDirectChildren(bytes, container, budget)) {
    budget.tick();
    if (candidate.type === RT_NOTES_ATOM && atom === undefined) atom = candidate;
  }
  if (atom === undefined || atom.end - atom.payloadStart < 4) throw corrupt();
  const slideId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    atom.payloadStart,
    true,
  );
  const slideIndex = slideIndexes.get(slideId);
  if (slideIndex === undefined) return;
  const slide = slides[slideIndex];
  if (slide === undefined) return;
  for (const record of walkChildren(bytes, container, budget, state)) {
    budget.tick();
    if (record.type !== RT_CLIENT_TEXTBOX || record.version !== 0x0f) continue;
    reserveObjects(state);
    const noteTexts: PptText[] = [];
    addTextFromTextbox(bytes, record, budget, state, stage, noteTexts, 2);
    for (const note of noteTexts) {
      budget.tick();
      reserveObjects(state);
      slide.slide.notes.push(note.text);
    }
    if (stage.stopped) return;
  }
}

function appendLiveSlideText(
  bytes: Uint8Array,
  work: SlideWork,
  persist: Map<number, number>,
  budget: Budget,
  state: ParserState,
  stage: TextStage,
): void {
  const offset = persist.get(work.persistId);
  if (offset === undefined) {
    unreadable(state, budget);
    return;
  }
  try {
    const container = readRecord(bytes, offset);
    const inline = parseInlineSlideText(bytes, container, budget, state, stage);
    for (const value of inline) {
      budget.tick();
      reserveObjects(state);
      work.slide.texts.push(value);
    }
  } catch (error) {
    if (!(error instanceof CorruptFileError)) throw error;
    unreadable(state, budget);
  }
}

function parseNotesList(
  bytes: Uint8Array,
  notesList: RecordHeader,
  persist: Map<number, number>,
  slides: SlideWork[],
  budget: Budget,
  state: ParserState,
  stage: TextStage,
): void {
  reserveObjects(state);
  const slideIndexes = new Map<number, number>();
  for (let index = 0; index < slides.length; index++) {
    budget.tick();
    reserveObjects(state);
    slideIndexes.set(slides[index]!.slide.id, index);
  }
  for (const child of readDirectChildren(bytes, notesList, budget)) {
    budget.tick();
    if (child.type !== RT_SLIDE_PERSIST) continue;
    if (child.version !== 0 || child.end - child.payloadStart !== 20) {
      unreadable(state, budget);
      continue;
    }
    const persistId = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      child.payloadStart,
      true,
    );
    const offset = persist.get(persistId);
    if (offset === undefined) {
      unreadable(state, budget);
      continue;
    }
    try {
      const note = readRecord(bytes, offset);
      parseNotesContainer(bytes, note, slideIndexes, slides, budget, state, stage);
    } catch (error) {
      if (!(error instanceof CorruptFileError)) throw error;
      unreadable(state, budget);
    }
    if (stage.stopped) return;
  }
}

/** Parse the live PowerPoint 97-2003 presentation state from its two streams. */
export function parsePresentation(
  documentStream: Uint8Array,
  currentUserStream: Uint8Array,
  budget: Budget,
): PptSlide[] {
  budget.tick();
  if (documentStream.byteLength === 0) throw corrupt();
  const state: ParserState = { retainedObjects: 1, warnedUnreadable: false };
  const currentEditOffset = parseCurrentUser(currentUserStream);
  const persist = buildPersistMap(documentStream, currentEditOffset, budget, state);
  const documentOffset = persist.get(1);
  if (documentOffset === undefined) throw corrupt();
  const document = readRecord(documentStream, documentOffset);
  const { slideList, notesList } = parseDocumentChildren(documentStream, document, budget);
  reserveObjects(state);
  const stage: TextStage = { chars: 0, stopped: false };
  const slides = parseSlideList(documentStream, slideList!, budget, state, stage);
  if (slides.length === 0 && !budget.truncated) throw corrupt();
  for (const slide of slides) {
    budget.tick();
    if (stage.stopped) break;
    appendLiveSlideText(documentStream, slide, persist, budget, state, stage);
  }
  if (notesList !== undefined && !stage.stopped) {
    try {
      parseNotesList(documentStream, notesList, persist, slides, budget, state, stage);
    } catch (error) {
      if (!(error instanceof CorruptFileError)) throw error;
      unreadable(state, budget);
    }
  }
  reserveObjects(state);
  const result: PptSlide[] = [];
  for (const item of slides) {
    budget.tick();
    result.push(item.slide);
  }
  return result;
}

import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { AbortError, CorruptFileError, EncryptedError } from '../../../src/core/errors.js';
import { parsePresentation } from '../../../src/readers/ppt/records.js';

const RT = {
  document: 0x03e8,
  slide: 0x03ee,
  notes: 0x03f0,
  notesAtom: 0x03f1,
  slidePersist: 0x03f3,
  drawing: 0x040c,
  outlineTextRef: 0x0f9e,
  textHeader: 0x0f9f,
  textChars: 0x0fa0,
  textBytes: 0x0fa8,
  slideListWithText: 0x0ff0,
  currentUser: 0x0ff6,
  persistDirectory: 0x1772,
  clientTextbox: 0xf00d,
};

interface SlideSpec {
  persistId: number;
  slideId: number;
  title: string;
  body?: string;
  inline?: string;
  outlineReference?: boolean;
  oddUtf16?: boolean;
  duplicateInline?: boolean;
}

interface NotesSpec {
  persistId: number;
  notesId: number;
  slideId: number;
  text: string;
}

interface FixtureOptions {
  slides?: SlideSpec[];
  notes?: NotesSpec[];
  replacement?: { persistId: number; slideId: number; text: string };
  currentUserToken?: number;
  currentEditOverride?: number;
  persistCountOverride?: number;
  nestedDepth?: number;
  extraSlideDescriptors?: number;
  textChunks?: number;
  duplicateSlideDescriptor?: boolean;
  malformedSlideListTail?: boolean;
  malformedInlineTail?: boolean;
}

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function join(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function joinList(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function record(
  type: number,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  options: { version?: number; instance?: number } = {},
): Uint8Array {
  const header = new Uint8Array(8);
  const view = new DataView(header.buffer);
  view.setUint16(0, ((options.instance ?? 0) << 4) | (options.version ?? 0), true);
  view.setUint16(2, type, true);
  view.setUint32(4, payload.length, true);
  return join(header, payload);
}

function container(type: number, children: Uint8Array[], instance = 0): Uint8Array {
  return record(type, joinList(children), { version: 0x0f, instance });
}

function textAtom(text: string, bytes = false, odd = false): Uint8Array {
  if (bytes) {
    return record(RT.textBytes, Uint8Array.from([...text].map((char) => char.charCodeAt(0) & 0xff)));
  }
  const payload = new Uint8Array(text.length * 2 + (odd ? 1 : 0));
  const view = new DataView(payload.buffer);
  for (let index = 0; index < text.length; index++) view.setUint16(index * 2, text.charCodeAt(index), true);
  return record(RT.textChars, payload);
}

function textHeader(type: number): Uint8Array {
  return record(RT.textHeader, u32(type));
}

function slidePersist(spec: SlideSpec): Uint8Array {
  return record(
    RT.slidePersist,
    join(u32(spec.persistId), u32(0), u32(spec.body === undefined ? 1 : 2), u32(spec.slideId), u32(0)),
  );
}

function outlineText(spec: SlideSpec): Uint8Array {
  const shapeContents = spec.outlineReference
    ? record(RT.outlineTextRef, u32(0))
    : join(textHeader(4), textAtom(spec.inline ?? '', false, spec.oddUtf16));
  const textbox = container(RT.clientTextbox, [shapeContents]);
  return container(RT.drawing, [textbox]);
}

function slideContainer(
  spec: SlideSpec,
  text?: string,
  nestedDepth = 0,
  malformedInlineTail = false,
): Uint8Array {
  const textContent = text ?? spec.inline;
  let drawing: Uint8Array<ArrayBufferLike> = new Uint8Array();
  if (textContent !== undefined) {
    const textbox = outlineText({ ...spec, inline: textContent, outlineReference: false });
    drawing = spec.duplicateInline ? join(textbox, textbox) : textbox;
  }
  for (let depth = 0; depth < nestedDepth; depth++) drawing = container(RT.drawing, [drawing]);
  const children = [record(0x03ef, new Uint8Array(16)), drawing];
  if (malformedInlineTail) children.push(new Uint8Array([0, 0, 0, 0]));
  return container(RT.slide, children);
}

function notesPersist(spec: NotesSpec): Uint8Array {
  return record(RT.slidePersist, join(u32(spec.persistId), u32(0), u32(0), u32(spec.notesId), u32(0)));
}

function notesContainer(spec: NotesSpec): Uint8Array {
  const atom = record(RT.notesAtom, join(u32(spec.slideId), new Uint8Array(12)));
  const text = container(RT.clientTextbox, [textHeader(2), textAtom(spec.text)]);
  return container(RT.notes, [atom, container(RT.drawing, [text])]);
}

function persistDirectory(
  entries: Array<{ persistId: number; offset: number[] }>,
  countOverride?: number,
): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [index, entry] of entries.entries()) {
    const count = index === 0 && countOverride !== undefined ? countOverride : entry.offset.length;
    chunks.push(u32(((count & 0x0fff) << 20) | (entry.persistId & 0x000f_ffff)));
    for (const offset of entry.offset) chunks.push(u32(offset));
  }
  return record(RT.persistDirectory, join(...chunks));
}

function userEdit(offsetLastEdit: number, offsetPersistDirectory: number): Uint8Array {
  const payload = join(
    u32(0),
    u16(0),
    u16(0),
    u32(offsetLastEdit),
    u32(offsetPersistDirectory),
    u32(1),
    u32(100),
    u16(1),
    u16(0),
  );
  return record(0x0ff5, payload);
}

function currentUser(offset: number, token = 0xe391c05f): Uint8Array {
  const payload = new Uint8Array(24);
  const view = new DataView(payload.buffer);
  view.setUint32(0, 20, true);
  view.setUint32(4, token, true);
  view.setUint32(8, offset, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0x03f4, true);
  view.setUint8(16, 3);
  view.setUint8(17, 0);
  view.setUint32(20, 8, true);
  return record(RT.currentUser, payload);
}

function makeFixture(options: FixtureOptions = {}): { document: Uint8Array; currentUser: Uint8Array } {
  const slides = options.slides ?? [
    { persistId: 20, slideId: 512, title: 'second in storage', body: 'body two', inline: 'inline two' },
    { persistId: 7, slideId: 256, title: 'first in storage', body: 'body one', outlineReference: true },
  ];
  const notes = options.notes ?? [
    { persistId: 31, notesId: 301, slideId: 256, text: 'notes for first slide' },
    { persistId: 30, notesId: 300, slideId: 512, text: 'notes for second slide' },
  ];
  const listChildren: Uint8Array[] = [];
  for (const slide of slides) {
    listChildren.push(slidePersist(slide));
    listChildren.push(textHeader(0), textAtom(slide.title, true));
    if (slide.body !== undefined) listChildren.push(textHeader(1), textAtom(slide.body, true));
  }
  if (options.extraSlideDescriptors !== undefined) {
    for (let index = 0; index < options.extraSlideDescriptors; index++) {
      listChildren.push(slidePersist({ persistId: 2, slideId: 1024 + index, title: '' }));
    }
  }
  if (options.textChunks !== undefined) {
    const header = textHeader(1);
    const atom = textAtom('x', true);
    for (let index = 0; index < options.textChunks; index++) listChildren.push(header, atom);
  }
  if (options.duplicateSlideDescriptor && slides[0] !== undefined) {
    listChildren.push(slidePersist(slides[0]));
  }
  if (options.malformedSlideListTail) listChildren.push(new Uint8Array([0, 0, 0, 0]));
  const slideList = container(RT.slideListWithText, listChildren, 0);
  const notesList = container(RT.slideListWithText, notes.map(notesPersist), 2);
  const documentContainer = container(RT.document, [slideList, notesList]);

  const parts: Uint8Array[] = [documentContainer];
  const offsets = new Map<number, number>();
  for (const slide of slides) {
    offsets.set(
      slide.persistId,
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    parts.push(slideContainer(slide, undefined, options.nestedDepth, options.malformedInlineTail));
  }
  for (const note of notes) {
    offsets.set(
      note.persistId,
      parts.reduce((sum, part) => sum + part.length, 0),
    );
    parts.push(notesContainer(note));
  }
  const oldDirectoryOffset = parts.reduce((sum, part) => sum + part.length, 0);
  const oldDirectory = persistDirectory([
    { persistId: 1, offset: [0] },
    ...slides.map((slide) => ({ persistId: slide.persistId, offset: [offsets.get(slide.persistId)!] })),
    ...notes.map((note) => ({ persistId: note.persistId, offset: [offsets.get(note.persistId)!] })),
  ]);
  parts.push(oldDirectory);
  const oldEditOffset = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(userEdit(0, oldDirectoryOffset));

  let currentEditOffset = oldEditOffset;
  if (options.replacement) {
    const newSlideOffset = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(
      slideContainer({
        persistId: options.replacement.persistId,
        slideId: options.replacement.slideId,
        title: '',
        inline: options.replacement.text,
      }),
    );
    const newDirectoryOffset = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(
      persistDirectory(
        [{ persistId: options.replacement.persistId, offset: [newSlideOffset] }],
        options.persistCountOverride,
      ),
    );
    currentEditOffset = parts.reduce((sum, part) => sum + part.length, 0);
    parts.push(userEdit(options.currentEditOverride ?? oldEditOffset, newDirectoryOffset));
  }

  return { document: join(...parts), currentUser: currentUser(currentEditOffset, options.currentUserToken) };
}

function budget(
  limits: Record<string, number> = {},
  options: { signal?: AbortSignal; onLimit?: 'truncate' | 'throw' } = {},
): Budget {
  return new Budget(resolveLimits(limits), options);
}

describe('parsePresentation', () => {
  it('uses the current persist map and SlideListWithText order, decoding text atoms', () => {
    const fixture = makeFixture({
      replacement: { persistId: 7, slideId: 256, text: 'live replacement' },
    });
    const result = parsePresentation(fixture.document, fixture.currentUser, budget());

    expect(result.map((slide) => slide.id)).toEqual([512, 256]);
    expect(result[0]?.texts).toEqual([
      { type: 0, text: 'second in storage' },
      { type: 1, text: 'body two' },
      { type: 4, text: 'inline two' },
    ]);
    expect(result[1]?.texts).toEqual([
      { type: 0, text: 'first in storage' },
      { type: 1, text: 'body one' },
      { type: 4, text: 'live replacement' },
    ]);
    expect(result[0]?.notes).toEqual(['notes for second slide']);
    expect(result[1]?.notes).toEqual(['notes for first slide']);
  });

  it('decodes TextBytesAtom as low-byte Unicode and preserves title text type 6', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: '\u0080\u00e9' }],
      notes: [],
    });
    const result = parsePresentation(fixture.document, fixture.currentUser, budget());
    expect(result[0]?.texts).toContainEqual({ type: 0, text: '\u0080\u00e9' });

    const titleSix = makeFixture({ slides: [{ persistId: 2, slideId: 300, title: 'Title six' }], notes: [] });
    // The fixture's first title header is type 0; change only that value to enum 6.
    const marker = record(RT.textHeader, u32(0));
    const replacement = record(RT.textHeader, u32(6));
    const position = titleSix.document.findIndex(
      (value, index, all) =>
        index + marker.length <= all.length &&
        all.slice(index, index + marker.length).every((b, i) => b === marker[i]),
    );
    expect(position).toBeGreaterThanOrEqual(0);
    titleSix.document.set(replacement, position);
    expect(parsePresentation(titleSix.document, titleSix.currentUser, budget())[0]?.texts[0]).toEqual({
      type: 6,
      text: 'Title six',
    });
  });

  it('ignores stale slide records replaced by the newest edit and does not duplicate outline text', () => {
    const fixture = makeFixture({ replacement: { persistId: 7, slideId: 256, text: 'latest only' } });
    const result = parsePresentation(fixture.document, fixture.currentUser, budget());
    expect(result[1]?.texts.filter((text) => text.text.includes('first in storage'))).toHaveLength(1);
    expect(result[1]?.texts.some((text) => text.text === 'latest only')).toBe(true);
    expect(result.flatMap((slide) => slide.texts).some((text) => text.text.includes('stale'))).toBe(false);
  });

  it('preserves identical inline text from separate shapes', () => {
    const fixture = makeFixture({
      slides: [
        {
          persistId: 2,
          slideId: 300,
          title: 'Repeated title',
          inline: 'same shape text',
          duplicateInline: true,
        },
      ],
      notes: [],
    });
    const result = parsePresentation(fixture.document, fixture.currentUser, budget());
    expect(result[0]?.texts.filter((text) => text.text === 'same shape text')).toHaveLength(2);
  });

  it('rejects encrypted and invalid CurrentUser records without exposing their content', () => {
    const fixture = makeFixture();
    expect(() => parsePresentation(fixture.document, currentUser(0, 0xf3d1c4df), budget())).toThrow(
      EncryptedError,
    );
    expect(() => parsePresentation(fixture.document, currentUser(0xffff_ffff), budget())).toThrow(
      CorruptFileError,
    );
    expect(() => parsePresentation(fixture.document, new Uint8Array(5), budget())).toThrow(CorruptFileError);
  });

  it('rejects slide IDs outside the MS-PPT valid range', () => {
    for (const slideId of [0xff, 0x8000_0000]) {
      const fixture = makeFixture({
        slides: [{ persistId: 2, slideId, title: 'invalid id' }],
        notes: [],
      });
      expect(() => parsePresentation(fixture.document, fixture.currentUser, budget())).toThrow(
        CorruptFileError,
      );
    }
  });

  it('emits at most one unreadable-part warning per parse', () => {
    const fixture = makeFixture({
      slides: [
        { persistId: 2, slideId: 300, title: 'valid slide' },
        { persistId: 3, slideId: 0xff, title: 'low invalid id' },
        { persistId: 4, slideId: 0x8000_0000, title: 'high invalid id' },
      ],
      notes: [],
    });
    const activeBudget = budget();
    expect(parsePresentation(fixture.document, fixture.currentUser, activeBudget)).toHaveLength(1);
    expect(
      activeBudget.warnings.warnings.filter((warning) => warning.code === 'UNREADABLE_PART'),
    ).toHaveLength(1);
  });

  it('caps retained slide descriptors and one-character text chunks at the reader safety limit', () => {
    const slides = makeFixture({ slides: [], notes: [], extraSlideDescriptors: 100_001 });
    expect(() => parsePresentation(slides.document, slides.currentUser, budget())).toThrowError(
      expect.objectContaining({ limit: 'pptObjects', value: 100_000 }),
    );

    const texts = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: '' }],
      notes: [],
      textChunks: 100_001,
    });
    expect(() => parsePresentation(texts.document, texts.currentUser, budget())).toThrowError(
      expect.objectContaining({ limit: 'pptObjects', value: 100_000 }),
    );
  });

  it('rejects cyclic and forward user-edit references and persist runs that exceed their record', () => {
    const cyclic = makeFixture({ replacement: { persistId: 7, slideId: 256, text: 'replacement' } });
    const newestOffset = cyclic.document.length - 36;
    // The final UserEditAtom is 36 bytes and its previous-edit pointer is at +16.
    new DataView(cyclic.document.buffer).setUint32(newestOffset + 16, newestOffset, true);
    expect(() => parsePresentation(cyclic.document, cyclic.currentUser, budget())).toThrow(CorruptFileError);

    const forward = makeFixture({ replacement: { persistId: 7, slideId: 256, text: 'replacement' } });
    new DataView(forward.document.buffer).setUint32(newestOffset + 16, forward.document.length + 8, true);
    expect(() => parsePresentation(forward.document, forward.currentUser, budget())).toThrow(
      CorruptFileError,
    );

    const oversizedRun = makeFixture({
      replacement: { persistId: 7, slideId: 256, text: 'replacement' },
      persistCountOverride: 100,
    });
    expect(() => parsePresentation(oversizedRun.document, oversizedRun.currentUser, budget())).toThrow(
      CorruptFileError,
    );
  });

  it('warns and returns valid slide text when one slide-local text record is malformed', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: 'Good slide', inline: 'broken', oddUtf16: true }],
      notes: [],
    });
    const result = parsePresentation(fixture.document, fixture.currentUser, budget());
    expect(result).toHaveLength(1);
    expect(result[0]?.texts).toContainEqual({ type: 0, text: 'Good slide' });
    expect(result[0]?.texts.some((text) => text.text.includes('\uFFFD'))).toBe(false);
  });

  it('keeps valid slides when the slide list has a malformed trailing record', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: 'valid prefix slide' }],
      notes: [],
      malformedSlideListTail: true,
    });
    const activeBudget = budget();
    const result = parsePresentation(fixture.document, fixture.currentUser, activeBudget);
    expect(result.map((slide) => slide.id)).toEqual([300]);
    expect(result[0]?.texts).toContainEqual({ type: 0, text: 'valid prefix slide' });
    expect(
      activeBudget.warnings.warnings.filter((warning) => warning.code === 'UNREADABLE_PART'),
    ).toHaveLength(1);
  });

  it('keeps valid inline text when a slide has a malformed trailing record', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: 'title', inline: 'valid inline prefix' }],
      notes: [],
      malformedInlineTail: true,
    });
    const activeBudget = budget();
    const result = parsePresentation(fixture.document, fixture.currentUser, activeBudget);
    expect(result[0]?.texts).toContainEqual({ type: 4, text: 'valid inline prefix' });
    expect(
      activeBudget.warnings.warnings.filter((warning) => warning.code === 'UNREADABLE_PART'),
    ).toHaveLength(1);
  });

  it('stops at blockDepth, responds to abort, and returns partial text when output preflight truncates', () => {
    const nested = makeFixture({ nestedDepth: 3 });
    const deepBudget = budget({ blockDepth: 1 });
    expect(() => parsePresentation(nested.document, nested.currentUser, deepBudget)).not.toThrow();
    expect(deepBudget.warnings.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);

    const controller = new AbortController();
    controller.abort();
    expect(() =>
      parsePresentation(nested.document, nested.currentUser, budget({}, { signal: controller.signal })),
    ).toThrow(AbortError);

    const limited = budget({ outputChars: 20 });
    const partial = parsePresentation(nested.document, nested.currentUser, limited);
    expect(
      partial
        .flatMap((slide) => slide.texts)
        .map((text) => text.text)
        .join(''),
    ).toBe('second in storage');
    expect(limited.truncated).toBe(true);
  });

  it('balances block depth when a strict depth limit throws', () => {
    const nested = makeFixture({ nestedDepth: 3 });
    const strictBudget = budget({ blockDepth: 1 }, { onLimit: 'throw' });
    expect(() => parsePresentation(nested.document, nested.currentUser, strictBudget)).toThrow();
    expect(strictBudget.enterDepth('block')).toBe(true);
    strictBudget.exitDepth('block');
  });

  it('keeps block depth balanced when the object guard trips before the initial walker frame', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: 'x' }],
      notes: [],
      textChunks: 33_326,
    });
    const activeBudget = budget({ blockDepth: 1 });
    let enteredDepths = 0;
    const originalEnterDepth = activeBudget.enterDepth.bind(activeBudget);
    activeBudget.enterDepth = (kind) => {
      enteredDepths++;
      return originalEnterDepth(kind);
    };
    expect(() => parsePresentation(fixture.document, fixture.currentUser, activeBudget)).toThrowError(
      expect.objectContaining({ limit: 'pptObjects', value: 100_000 }),
    );
    expect(enteredDepths).toBe(0);
    expect(activeBudget.enterDepth('block')).toBe(true);
    activeBudget.exitDepth('block');
  });

  it('keeps block depth balanced when the object guard trips before a nested walker frame', () => {
    const fixture = makeFixture({
      slides: [{ persistId: 2, slideId: 300, title: 'x' }],
      notes: [],
      duplicateSlideDescriptor: true,
      nestedDepth: 2,
      textChunks: 33_325,
    });
    const activeBudget = budget({ blockDepth: 2 });
    let enteredDepths = 0;
    const originalEnterDepth = activeBudget.enterDepth.bind(activeBudget);
    activeBudget.enterDepth = (kind) => {
      enteredDepths++;
      return originalEnterDepth(kind);
    };
    expect(() => parsePresentation(fixture.document, fixture.currentUser, activeBudget)).toThrowError(
      expect.objectContaining({ limit: 'pptObjects', value: 100_000 }),
    );
    expect(enteredDepths).toBe(1);
    expect(activeBudget.enterDepth('block')).toBe(true);
    expect(activeBudget.enterDepth('block')).toBe(true);
    expect(activeBudget.enterDepth('block')).toBe(false);
    activeBudget.exitDepth('block');
    activeBudget.exitDepth('block');
    activeBudget.exitDepth('block');
  });
});

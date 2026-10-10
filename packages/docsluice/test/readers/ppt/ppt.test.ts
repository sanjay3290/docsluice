import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { CorruptFileError, EncryptedError } from '../../../src/core/errors.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Limits } from '../../../src/core/limits.js';
import type { Block } from '../../../src/core/model.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { writeCfb } from '../../../src/ole/write.js';
import { pptReader } from '../../../src/readers/ppt/index.js';
import { parsePresentation } from '../../../src/readers/ppt/records.js';

// [MS-PPT] records, built by hand: header (version/instance, type, length) then body.
function concat(parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
function record(type: number, body: Uint8Array = new Uint8Array(0), instance = 0, version = 0): Uint8Array {
  const bytes = new Uint8Array(8 + body.length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, (instance << 4) | version, true);
  view.setUint16(2, type, true);
  view.setUint32(4, body.length, true);
  bytes.set(body, 8);
  return bytes;
}
const container = (type: number, children: Uint8Array[], instance = 0) =>
  record(type, concat(children), instance, 0x0f);
function u32(...values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  values.forEach((value, index) => new DataView(bytes.buffer).setUint32(index * 4, value, true));
  return bytes;
}
function utf16(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index++)
    new DataView(bytes.buffer).setUint16(index * 2, text.charCodeAt(index), true);
  return bytes;
}
const persist = (persistId: number, slideId: number) => record(0x03f3, u32(persistId, 0, 0, slideId, 0));
const header = (type: number) => record(0x0f9f, u32(type));
const chars = (text: string) => record(0x0fa0, utf16(text));
const bytesAtom = (text: string) =>
  record(
    0x0fa8,
    Uint8Array.from(text, (char) => char.charCodeAt(0)),
  );
const placeholder = (kind: number) =>
  container(0xf011, [record(0x0bc3, Uint8Array.of(0, 0, 0, 0, kind, 0, 0, 0))]);
/** A shape (`SpContainer`) with an optional placeholder and a client text box. */
const shape = (box: Uint8Array[], kind?: number) =>
  container(0xf004, [...(kind === undefined ? [] : [placeholder(kind)]), container(0xf00d, box)]);
const drawing = (shapes: Uint8Array[]) => container(0x040c, [container(0xf002, [container(0xf003, shapes)])]);
const slide = (shapes: Uint8Array[]) =>
  container(0x03ee, [record(0x03ef, new Uint8Array(24), 0, 2), drawing(shapes)]);
const notes = (slideId: number, shapes: Uint8Array[]) =>
  container(0x03f0, [record(0x03f1, u32(slideId, 0), 0, 1), drawing(shapes)]);

interface Edit {
  /** Persist id → object bytes, written in this save. */
  objects: Array<[number, Uint8Array]>;
  /** Raw bytes added before this save's objects. */
  prefix?: Uint8Array;
}

/**
 * A `PowerPoint Document` stream with one or more saves: each save appends its objects, a
 * persist directory and a UserEditAtom chained to the previous save.
 */
function stream(edits: Edit[], options: { lastEdit?: (offset: number) => number; encrypt?: boolean } = {}) {
  const parts: Uint8Array[] = [];
  let offset = 0;
  let previous = 0;
  const add = (bytes: Uint8Array) => {
    const at = offset;
    parts.push(bytes);
    offset += bytes.length;
    return at;
  };
  for (const edit of edits) {
    if (edit.prefix) add(edit.prefix);
    const entries: number[] = [];
    for (const [id, bytes] of edit.objects) entries.push((1 << 20) | id, add(bytes));
    const directory = add(record(0x1772, u32(...entries)));
    const editOffset = offset;
    const fields = [0, 0x03000000, options.lastEdit?.(editOffset) ?? previous, directory, 1, 10, 1];
    if (options.encrypt) fields.push(9);
    add(record(0x0ff5, u32(...fields)));
    previous = editOffset;
  }
  return { document: concat(parts), edit: previous };
}
const currentUser = (edit: number, token = 0xe391c05f) =>
  record(0x0ff6, concat([u32(20, token, edit), new Uint8Array(8)]));
const documentContainer = (lists: Uint8Array[]) => container(0x03e8, lists);
const slideList = (children: Uint8Array[]) => container(0x0ff0, children, 0);
const notesList = (children: Uint8Array[]) => container(0x0ff0, children, 2);

function parse(document: Uint8Array, edit: number, limits: Partial<Limits> = {}) {
  const warnings = new WarningSink();
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings });
  return { result: parsePresentation(document, currentUser(edit), budget, warnings), warnings };
}

function file(document: Uint8Array, user: Uint8Array, extra: Array<{ path: string; data: Uint8Array }> = []) {
  const budget = new Budget(DEFAULT_LIMITS, { warnings: new WarningSink() });
  return writeCfb(
    [
      { path: 'Current User', type: 'stream', data: user },
      { path: 'PowerPoint Document', type: 'stream', data: document },
      ...extra.map((entry) => ({ ...entry, type: 'stream' as const })),
    ],
    budget,
  )!;
}

type Section = Extract<Block, { kind: 'section' }>;
const sections = (blocks: Block[]) => blocks.filter((block): block is Section => block.kind === 'section');
const texts = (section: Section) =>
  section.blocks.map((block) => ('text' in block ? `${block.kind}:${block.text}` : block.kind));

describe('PPT records ([MS-PPT])', () => {
  it('reads slide-list placeholders, drawing text boxes and notes in slide order', () => {
    const list = slideList([
      persist(2, 300),
      header(0),
      chars('Second id, first slide'),
      header(1),
      chars('Body one\rBody two\vline'),
      persist(3, 256),
      header(6),
      bytesAtom('Centered caf\xe9'),
    ]);
    const { document, edit } = stream([
      {
        objects: [
          [1, documentContainer([container(0x0ff0, [], 1), list, notesList([persist(4, 0), persist(5, 0)])])],
          [
            2,
            slide([
              shape([header(4), chars('Text box')]),
              shape([record(0x0f9e, u32(0)), header(1), chars('Outline copy, skipped')]),
              shape([header(4), chars('*')], 0x08),
              shape([header(4), chars('Placed title')], 0x0d),
            ]),
          ],
          [3, slide([])],
          [
            4,
            notes(300, [shape([header(2), chars('Note body')], 0x0c), shape([header(4), chars('Note box')])]),
          ],
          [
            5,
            notes(256, [
              shape([header(0), chars('Not a note')]),
              shape([header(4), chars('Placeholder')], 0x05),
            ]),
          ],
        ],
      },
    ]);
    const { result, warnings } = parse(document, edit);
    expect(warnings.warnings).toEqual([]);
    expect(result.slides).toEqual([
      {
        texts: [
          { type: 0, paragraphs: ['Second id, first slide'] },
          { type: 1, paragraphs: ['Body one', 'Body two\nline'] },
          { type: 4, paragraphs: ['Text box'] },
          { type: 0, placeholder: true, paragraphs: ['Placed title'] },
        ],
        notes: ['Note body', 'Note box'],
      },
      { texts: [{ type: 6, paragraphs: ['Centered café'] }], notes: [] },
    ]);
  });

  it('follows the edit chain so later saves replace earlier objects', () => {
    const first = documentContainer([slideList([persist(2, 256), header(1), chars('Old list text')])]);
    const second = documentContainer([slideList([persist(2, 256), header(1), chars('New list text')])]);
    const { document, edit } = stream([
      {
        objects: [
          [1, first],
          [2, slide([shape([header(4), chars('Old box')])])],
        ],
      },
      {
        objects: [
          [1, second],
          [2, slide([shape([header(4), chars('New box')])])],
        ],
      },
    ]);
    expect(parse(document, edit).result.slides).toEqual([
      {
        texts: [
          { type: 1, paragraphs: ['New list text'] },
          { type: 4, paragraphs: ['New box'] },
        ],
        notes: [],
      },
    ]);
  });

  it('keeps placeholder text when slide or notes objects are missing, with one warning', () => {
    const { document, edit } = stream([
      {
        objects: [
          [
            1,
            documentContainer([
              slideList([persist(7, 256), header(0), chars('Kept title'), record(0x03f3, u32(1))]),
              notesList([persist(8, 0), persist(1, 0)]),
            ]),
          ],
        ],
      },
    ]);
    const { result, warnings } = parse(document, edit);
    expect(result.slides).toEqual([{ texts: [{ type: 0, paragraphs: ['Kept title'] }], notes: [] }]);
    expect(warnings.warnings.map((warning) => [warning.code, warning.message])).toEqual([
      ['UNREADABLE_PART', '3 slide or notes records could not be found; their placeholder text is kept.'],
    ]);
  });

  it('ignores truncated records, notes for unknown slides and odd text atoms', () => {
    const list = slideList([
      persist(2, 256),
      record(0x0f9f, Uint8Array.of(1)),
      chars('No header'),
      header(1),
    ]);
    const broken = concat([list.subarray(0, list.length), record(0x0fa0, utf16('x')).subarray(0, 6)]);
    const { document, edit } = stream([
      {
        objects: [
          [1, container(0x03e8, [broken, notesList([persist(3, 0)])])],
          [
            2,
            slide([
              container(0xf004, [placeholder(0x0d)]),
              shape([header(4), record(0x0fa0, Uint8Array.of(0x41, 0, 0x42))]),
            ]),
          ],
          [3, notes(999, [shape([header(2), chars('Orphan note')])])],
        ],
      },
    ]);
    expect(parse(document, edit).result.slides).toEqual([
      { texts: [{ type: 4, paragraphs: ['A'] }], notes: [] },
    ]);
  });

  it('stops at blockDepth inside drawings', () => {
    let nested = shape([header(4), chars('deep')]);
    for (let depth = 0; depth < 5; depth++) nested = container(0xf003, [nested]);
    const { document, edit } = stream([
      {
        objects: [
          [1, documentContainer([slideList([persist(2, 256)])])],
          [2, container(0x03ee, [nested])],
        ],
      },
    ]);
    expect(parse(document, edit, { blockDepth: 3 }).result).toEqual({
      slides: [{ texts: [], notes: [] }],
      depthLimited: true,
    });
    expect(parse(document, edit).result.depthLimited).toBe(false);
  });

  it.each([
    [
      'a Current User record of another type',
      () =>
        parsePresentation(new Uint8Array(0), record(0x0ff5, new Uint8Array(12)), budget(), new WarningSink()),
    ],
    [
      'an unknown Current User token',
      () => parsePresentation(new Uint8Array(0), currentUser(0, 1), budget(), new WarningSink()),
    ],
    ['an edit offset past the stream', () => parse(new Uint8Array(16), 4)],
    [
      'a persist directory of another type',
      () => {
        const { document, edit } = stream([{ objects: [] }]);
        document[edit - 32 + 2] = 0;
        return parse(document, edit);
      },
    ],
    [
      'an edit chain that does not move back',
      () => {
        const { document, edit } = stream([{ objects: [[1, documentContainer([])]] }], {
          lastEdit: (offset) => offset,
        });
        return parse(document, edit);
      },
    ],
    [
      'a missing document container',
      () => {
        const { document, edit } = stream([{ objects: [[1, slide([])]] }]);
        return parse(document, edit);
      },
    ],
  ])('rejects %s', (_case, run) => {
    expect(run).toThrow(CorruptFileError);
  });

  it('reports encryption from the Current User token and the UserEditAtom', () => {
    expect(() =>
      parsePresentation(new Uint8Array(0), currentUser(0, 0xf3d1c4df), budget(), new WarningSink()),
    ).toThrow(EncryptedError);
    const { document, edit } = stream([{ objects: [[1, documentContainer([])]] }], { encrypt: true });
    expect(() => parse(document, edit)).toThrow(EncryptedError);
  });

  it('accepts a deck with no slide list', () => {
    const { document, edit } = stream([{ objects: [[1, documentContainer([])]] }]);
    expect(parse(document, edit).result).toEqual({ slides: [], depthLimited: false });
  });
});

function budget(): Budget {
  return new Budget(DEFAULT_LIMITS, { warnings: new WarningSink() });
}

describe('PPT reader', () => {
  const corpus = (name: string) =>
    new Uint8Array(readFileSync(new URL(`../../../../../corpus/${name}`, import.meta.url)));

  it('is detected and turns slides into sections with titles, text and notes', async () => {
    expect(pptReader.id).toBe('ppt');
    const doc = await extract(corpus('ppt/ppt-order-title-notes.ppt'));
    expect(doc.format).toBe('ppt');
    const [first, second, third] = sections(doc.blocks);
    expect(first).toMatchObject({ role: 'slide', title: 'TEN FIRST', loc: { slide: 1 } });
    expect(texts(first!)).toEqual([
      'heading:TEN FIRST',
      'paragraph:Slide one body: Alpha',
      'note:Speaker note one: note ten',
    ]);
    expect(texts(second!)).toContain('paragraph:Slide two body: café Ω 中');
    expect(texts(third!)).toEqual([
      'paragraph:ONE LAST',
      'paragraph:Slide three body: Omega',
      'paragraph:Second paragraph',
      'paragraph:Third paragraph',
      'paragraph:A free text box',
      'note:Speaker note three: note one',
    ]);
  });

  it('puts the child path in locations and stops when the output is full', async () => {
    const { document, edit } = stream([
      {
        objects: [
          [
            1,
            documentContainer([
              slideList([
                persist(2, 256),
                header(0),
                chars('Title'),
                header(1),
                chars('Body text'),
                persist(3, 257),
                header(0),
                chars('Next'),
              ]),
            ]),
          ],
          [2, slide([])],
          [3, slide([])],
        ],
      },
    ]);
    const deck = file(document, currentUser(edit));
    const nested = await extract(zipSync({ 'decks/old.ppt': deck }), { children: 'extract' });
    const child = nested.children[0]!.document!;
    expect(child.format).toBe('ppt');
    expect(sections(child.blocks)[0]!.loc).toMatchObject({ slide: 1, path: 'decks/old.ppt' });
    for (const outputChars of [3, 7, 14]) {
      const cut = await extract(deck, { limits: { outputChars } });
      expect(cut.stats.truncated).toBe(true);
      expect(sections(cut.blocks).length).toBeLessThan(2);
    }
  });

  it('needs both PowerPoint streams', async () => {
    const budgetForWrite = budget();
    const only = writeCfb(
      [{ path: 'PowerPoint Document', type: 'stream', data: new Uint8Array(8) }],
      budgetForWrite,
    )!;
    await expect(extract(only, { format: 'ppt' })).rejects.toThrow(CorruptFileError);
  });
});

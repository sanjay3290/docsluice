import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { AbortError, LimitExceededError, StrictModeError } from '../../../src/core/errors.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { pptxReader } from '../../../src/readers/pptx/index.js';
import { makeZip } from '../../helpers/zip.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const encoder = new TextEncoder();

function packageBytes(notes: string | Uint8Array, hidden = false, external = false) {
  const files = [
    {
      name: '_rels/.rels',
      data: `<Relationships xmlns="${PKG}"><Relationship Id="root" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    },
    {
      name: 'ppt/presentation.xml',
      data: `<p:presentation xmlns:p="${P}" xmlns:q="${R}"><p:sldIdLst><p:sldId id="256" q:id="s"/></p:sldIdLst></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      data: `<Relationships xmlns="${PKG}"><Relationship Id="s" Type="${R}/slide" Target="slides/slide1.xml"/></Relationships>`,
    },
    {
      name: 'ppt/slides/slide1.xml',
      data: `<p:sld xmlns:p="${P}"${hidden ? ' show="0"' : ''}><p:cSld><p:spTree/></p:cSld></p:sld>`,
    },
    {
      name: 'ppt/slides/_rels/slide1.xml.rels',
      data: `<Relationships xmlns="${PKG}"><Relationship Id="n" Type="${R}/notesSlide" Target="${external ? 'https://example.invalid/notes.xml' : '../notesSlides/n.xml'}"${external ? ' TargetMode="External"' : ''}/></Relationships>`,
    },
    { name: 'ppt/notesSlides/n.xml', data: notes },
  ];
  return makeZip(
    files.map((file) => ({
      name: file.name,
      data: typeof file.data === 'string' ? encoder.encode(file.data) : file.data,
    })),
  );
}

function notePart(first = 'ab', second = 'cd') {
  return `<p:notes xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${first}</a:t></a:r></a:p><a:p><a:r><a:t>${second}</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>EXCLUDED</a:t></a:r></a:p></p:txBody></p:sp>
    </p:spTree></p:cSld></p:notes>`;
}

async function read(
  bytes: Uint8Array,
  config: {
    outputChars?: number;
    onLimit?: 'truncate' | 'throw';
    includeHidden?: boolean;
    strict?: boolean;
    signal?: AbortSignal;
  } = {},
) {
  const warnings = new WarningSink({ strict: config.strict });
  const limits = resolveLimits(config.outputChars === undefined ? {} : { outputChars: config.outputChars });
  const budget = new Budget(limits, { warnings, onLimit: config.onLimit, signal: config.signal });
  const out = new DocBuilder('pptx', MIME, budget);
  const ctx = {
    bytes,
    budget,
    warnings,
    out,
    path: 'outer.zip/talk.pptx',
    options: {
      limits,
      onLimit: config.onLimit ?? 'truncate',
      metadata: false,
      strict: config.strict ?? false,
      children: 'list',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: config.includeHidden ?? false,
      formulas: false,
    },
    extractChild: () => Promise.resolve(undefined),
  } as ReadContext;
  await pptxReader.read(ctx);
  return { document: out.finish(), budget };
}

describe('PPTX notes and hidden-slide integration', () => {
  it('recovers invalid UTF-8 notes without emitting replacement characters', async () => {
    const source = notePart('BROKEN');
    const bytes = encoder.encode(source);
    bytes[source.indexOf('BROKEN')] = 0xff;
    const { document } = await read(packageBytes(bytes));
    expect(document.blocks[0]).toMatchObject({ blocks: [] });
    expect(document.warnings.filter((warning) => warning.code === 'UNREADABLE_PART')).toHaveLength(1);
  });

  it.each(['utf-16le', 'utf-16be'])(
    'preserves valid %s notes and recovers invalid surrogates',
    async (encoding) => {
      const source = notePart('Ω', '中');
      const bytes = new Uint8Array(2 + source.length * 2);
      bytes.set(encoding === 'utf-16le' ? [0xff, 0xfe] : [0xfe, 0xff]);
      const view = new DataView(bytes.buffer);
      for (let index = 0; index < source.length; index += 1)
        view.setUint16(2 + index * 2, source.charCodeAt(index), encoding === 'utf-16le');
      const valid = await read(packageBytes(bytes));
      expect(valid.document.blocks[0]).toMatchObject({ blocks: [{ text: 'Ω\n中' }] });
      view.setUint16(2 + source.indexOf('Ω') * 2, 0xd800, encoding === 'utf-16le');
      const invalid = await read(packageBytes(bytes));
      expect(invalid.document.blocks[0]).toMatchObject({ blocks: [] });
      expect(invalid.document.warnings.filter((warning) => warning.code === 'UNREADABLE_PART')).toHaveLength(
        1,
      );
    },
  );
  it.each([false, true])(
    'includes hidden slides and marks them regardless of includeHidden=%s',
    async (includeHidden) => {
      const { document } = await read(packageBytes(notePart(), true), { includeHidden });
      expect(document.blocks).toHaveLength(1);
      expect(document.blocks[0]).toMatchObject({
        kind: 'section',
        role: 'slide',
        hidden: true,
        loc: { slide: 1 },
        blocks: [
          {
            kind: 'note',
            role: 'speaker-notes',
            text: 'ab\ncd',
            loc: { slide: 1, path: 'outer.zip/talk.pptx/ppt/notesSlides/n.xml' },
          },
        ],
      });
      expect(document.warnings.filter((warning) => warning.code === 'HIDDEN_CONTENT')).toHaveLength(1);
      expect(JSON.stringify(document.blocks)).not.toContain('EXCLUDED');
    },
  );

  it('counts retained note text exactly once, with a complete paragraph prefix on truncation', async () => {
    const exact = await read(packageBytes(notePart()), { outputChars: 5 });
    expect(exact.budget.outputChars).toBe(5);
    expect(exact.budget.truncated).toBe(false);
    const partial = await read(packageBytes(notePart()), { outputChars: 4 });
    expect(partial.budget.truncated).toBe(true);
    expect(partial.document.blocks[0]).toMatchObject({ blocks: [{ text: 'ab' }] });
    await expect(read(packageBytes(notePart()), { outputChars: 4, onLimit: 'throw' })).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  });

  it('recovers an invalid notes structure with one static part warning and retains its slide', async () => {
    const { document } = await read(packageBytes(`<p:notes xmlns:p="${P}"><p:cSld/></p:notes>`));
    expect(document.blocks).toHaveLength(1);
    expect(document.warnings.filter((warning) => warning.code === 'UNREADABLE_PART')).toEqual([
      {
        code: 'UNREADABLE_PART',
        message: 'A PowerPoint notes part could not be read.',
        loc: { path: 'outer.zip/talk.pptx/ppt/notesSlides/n.xml' },
      },
    ]);
  });

  it('ignores external notes relationships and propagates strict and abort errors', async () => {
    const external = await read(packageBytes(notePart(), false, true));
    expect(external.document.blocks[0]).toMatchObject({ blocks: [] });
    await expect(read(packageBytes(notePart(), true), { strict: true })).rejects.toBeInstanceOf(
      StrictModeError,
    );
    const controller = new AbortController();
    controller.abort();
    await expect(read(packageBytes(notePart()), { signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it('matches manually reviewed notes and hidden state in the real LibreOffice deck', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../../corpus/pptx/pptx-lo-edge-cases.pptx', import.meta.url)),
    );
    const { document } = await read(bytes);
    const slides = document.blocks.filter((block) => block.kind === 'section');
    expect(slides).toHaveLength(12);
    expect(slides[4]?.hidden).toBe(true);
    expect(slides.filter((slide) => slide.hidden)).toHaveLength(1);
    for (const index of [3, 4])
      expect(slides[index]?.blocks).toContainEqual(
        expect.objectContaining({
          kind: 'note',
          role: 'speaker-notes',
          text: 'Speaker note body\nSecond note paragraph',
        }),
      );
    expect(document.warnings.filter((warning) => warning.code === 'HIDDEN_CONTENT')).toHaveLength(1);
  });
});

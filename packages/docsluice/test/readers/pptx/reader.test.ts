import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { openZip } from '../../../src/zip/index.js';
import { pptxReader } from '../../../src/readers/pptx/index.js';
import { makeZip } from '../../helpers/zip.js';

const MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

async function readFixture(
  name: string,
  limits: Record<string, number> = {},
  onLimit: 'truncate' | 'throw' = 'truncate',
  path = '',
  prepareOut?: (out: DocBuilder, budget: Budget) => void,
) {
  const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
  return readBytes(bytes, limits, onLimit, path, prepareOut);
}

async function readBytes(
  bytes: Uint8Array,
  limits: Record<string, number> = {},
  onLimit: 'truncate' | 'throw' = 'truncate',
  path = '',
  prepareOut?: (out: DocBuilder, budget: Budget) => void,
) {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings, onLimit });
  const out = new DocBuilder('pptx', MIME, budget);
  prepareOut?.(out, budget);
  const context = {
    bytes,
    options: {
      limits: resolveLimits(limits),
      onLimit,
      strict: false,
      metadata: true,
      children: 'extract',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: false,
      formulas: false,
    },
    budget,
    warnings,
    out,
    path,
    extractChild: () => Promise.resolve(undefined),
    zip: openZip(bytes, budget),
  } as ReadContext;
  await pptxReader.read(context);
  return { document: out.finish(), budget };
}

describe('PPTX reader', () => {
  it('uses presentation relationship order and extracts titles, reading order, tables, groups, and SmartArt', async () => {
    const { document } = await readFixture('pptx-edge-cases.pptx');
    const slides = document.blocks.filter((block) => block.kind === 'section');
    expect(slides).toHaveLength(12);
    expect(slides.map((block) => block.loc.slide)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(slides.map((block) => block.title)).toEqual([
      'SmartArt and chart slide',
      'Order and layout fixture',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(slides[0]).toMatchObject({ role: 'slide', title: 'SmartArt and chart slide' });
    expect(slides[0]?.blocks[0]).toMatchObject({
      kind: 'heading',
      level: 1,
      text: 'SmartArt and chart slide',
    });

    const second = slides[1]!;
    expect(second).toMatchObject({ title: 'Order and layout fixture' });
    const text = second.blocks.flatMap((block) =>
      block.kind === 'paragraph' || block.kind === 'heading'
        ? [block.text]
        : block.kind === 'list'
          ? block.items.map((item) => item.text)
          : [],
    );
    expect(text.indexOf('Top row right before lower row left')).toBeLessThan(
      text.indexOf('Lower row left after top row right'),
    );
    expect(text.indexOf('Tie document order first')).toBeLessThan(text.indexOf('Tie document order second'));
    expect(text.indexOf('Left column')).toBeLessThan(text.indexOf('Right column'));
    expect(text).toContain('Inherited placeholder content');
    expect(text).toContain('Transformed group child');
    expect(second.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'table',
        rows: [
          [{ text: 'Header A' }, { text: 'Header B' }],
          [{ text: 'Cell 1' }, { text: 'Cell 2' }],
        ],
      }),
    );
    const smartArt = slides[0]?.blocks.find((block) => block.kind === 'list');
    expect(smartArt?.kind).toBe('list');
    if (smartArt?.kind === 'list') {
      const smartArtText = smartArt.items.map((item) => item.text);
      expect(smartArtText).toContain('SmartArt node one');
      expect(smartArtText).toContain('SmartArt node two');
    }
    expect(document.blocks.some((block) => block.kind === 'note')).toBe(false);
    expect(slides[2]?.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'Slide 1 content' }),
    );
  });

  it('stops nested groups at blockDepth and balances depth when the limit throws', async () => {
    const partial = await readFixture('pptx-deep-group-1000.pptx', { blockDepth: 3, xmlDepth: 1200 });
    expect(partial.budget.truncated).toBe(true);
    expect(
      partial.document.blocks.some((block) => block.kind === 'paragraph' && block.text === 'Deep leaf'),
    ).toBe(false);
    expect(partial.document.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);

    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/pptx-deep-group-1000.pptx', import.meta.url)),
    );
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits({ blockDepth: 3, xmlDepth: 1200 }), {
      warnings,
      onLimit: 'throw',
    });
    const context = {
      bytes,
      options: {
        limits: resolveLimits({ blockDepth: 3, xmlDepth: 1200 }),
        onLimit: 'throw',
        strict: false,
        metadata: true,
        children: 'extract',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
        formulas: false,
      },
      budget,
      warnings,
      out: new DocBuilder('pptx', MIME, budget),
      path: '',
      extractChild: () => Promise.resolve(undefined),
      zip: openZip(bytes, budget),
    } as ReadContext;
    await expect(pptxReader.read(context)).rejects.toBeInstanceOf(LimitExceededError);
    expect(budget.enterDepth('block')).toBe(true);
    expect(budget.enterDepth('block')).toBe(true);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
    budget.exitDepth('block');
    budget.exitDepth('block');
  });

  it('charges retained table cells and emits only the permitted table prefix when truncating', async () => {
    const { document, budget } = await readFixture('pptx-edge-cases.pptx', { cells: 1 });
    const slides = document.blocks.filter((block) => block.kind === 'section');
    const table = slides[1]?.blocks.find((block) => block.kind === 'table');
    expect(table?.kind).toBe('table');
    if (table?.kind === 'table') {
      expect(table.rows).toEqual([[{ text: 'Header A' }]]);
    }
    expect(budget.cells).toBe(2);
    expect(budget.truncated).toBe(true);
    expect(document.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
  });

  it('throws the typed cell limit when the caller requests hard failure', async () => {
    await expect(readFixture('pptx-edge-cases.pptx', { cells: 1 }, 'throw')).rejects.toBeInstanceOf(
      LimitExceededError,
    );
  });

  it.each([0, 5])('does not spend outputChars parsing XML (limit %i)', async (outputChars) => {
    const { document, budget } = await readFixture('pptx-edge-cases.pptx', { outputChars });
    expect(budget.truncated).toBe(true);
    expect(document.warnings.some((warning) => warning.code === 'TRUNCATED')).toBe(true);
    expect(document.blocks.filter((block) => block.kind === 'section').length).toBeLessThanOrEqual(1);
  });

  it('closes a section whose output preflight returns false and leaves block depth balanced', async () => {
    const { document, budget } = await readFixture(
      'pptx-edge-cases.pptx',
      {},
      'truncate',
      '',
      (out, sharedBudget) => {
        const original = out.openSection.bind(out);
        vi.spyOn(out, 'openSection').mockImplementation((role, loc, title) => {
          const preflight = vi.spyOn(sharedBudget, 'checkOutputChars').mockReturnValue(false);
          try {
            return original(role, loc, title);
          } finally {
            preflight.mockRestore();
          }
        });
      },
    );
    expect(document.blocks).toEqual([]);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
  });

  it('preserves parent and slide-part provenance and resolves relationship attributes by namespace', async () => {
    const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const officeRelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = [
      {
        name: '_rels/.rels',
        data: `<Relationships xmlns="${relNs}"><Relationship Id="root" Type="${officeRelNs}/officeDocument" Target="custom/presentation.xml"/></Relationships>`,
      },
      {
        name: 'custom/presentation.xml',
        data: `<p:presentation xmlns:p="${presentationNs}" xmlns:q="${officeRelNs}"><p:sldIdLst><p:sldId id="512" q:id="slideRef"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: 'custom/_rels/presentation.xml.rels',
        data: `<Relationships xmlns="${relNs}"><Relationship Id="slideRef" Type="${officeRelNs}/slide" Target="slides/slide1.xml"/></Relationships>`,
      },
      { name: 'custom/slides/slide1.xml', data: '<broken' },
    ];
    const bytes = makeZip(
      files.map((file) => ({ name: file.name, data: new TextEncoder().encode(file.data) })),
    );
    const { document } = await readBytes(bytes, {}, 'truncate', 'outer.docx/embedded.pptx');
    const warning = document.warnings.find((item) => item.code === 'UNREADABLE_PART');
    expect(warning?.loc?.path).toBe('outer.docx/embedded.pptx/custom/slides/slide1.xml');
  });

  it('skips a slide with a missing shape tree and continues with later slides', async () => {
    const relNs = 'http://schemas.openxmlformats.org/package/2006/relationships';
    const presentationNs = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const officeRelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const files = [
      {
        name: '_rels/.rels',
        data: `<Relationships xmlns="${relNs}"><Relationship Id="root" Type="${officeRelNs}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
      },
      {
        name: 'ppt/presentation.xml',
        data: `<p:presentation xmlns:p="${presentationNs}" xmlns:r="${officeRelNs}"><p:sldIdLst><p:sldId id="512" r:id="s1"/><p:sldId id="513" r:id="s2"/><p:sldId id="514" r:id="s3"/></p:sldIdLst></p:presentation>`,
      },
      {
        name: 'ppt/_rels/presentation.xml.rels',
        data: `<Relationships xmlns="${relNs}"><Relationship Id="s1" Type="${officeRelNs}/slide" Target="slides/slide1.xml"/><Relationship Id="s2" Type="${officeRelNs}/slide" Target="slides/slide2.xml"/><Relationship Id="s3" Type="${officeRelNs}/slide" Target="slides/slide3.xml"/></Relationships>`,
      },
      {
        name: 'ppt/slides/slide1.xml',
        data: `<p:sld xmlns:p="${presentationNs}"><p:cSld><p:spTree/></p:cSld></p:sld>`,
      },
      {
        name: 'ppt/slides/slide2.xml',
        data: `<p:sld xmlns:p="${presentationNs}"><p:cSld/></p:sld>`,
      },
      {
        name: 'ppt/slides/slide3.xml',
        data: `<p:sld xmlns:p="${presentationNs}"><p:cSld><p:spTree/></p:cSld></p:sld>`,
      },
    ];
    const bytes = makeZip(
      files.map((file) => ({ name: file.name, data: new TextEncoder().encode(file.data) })),
    );
    const { document } = await readBytes(bytes);
    const slides = document.blocks.filter((block) => block.kind === 'section');
    expect(slides.map((slide) => slide.loc.slide)).toEqual([1, 3]);
    const unreadable = document.warnings.filter((warning) => warning.code === 'UNREADABLE_PART');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]?.loc?.path).toBe('ppt/slides/slide2.xml');
  });

  it('adds parent and slide-part paths to section and block locations', async () => {
    const { document } = await readFixture(
      'pptx-edge-cases.pptx',
      {},
      'truncate',
      'outer.docx/embedded.pptx',
    );
    const slides = document.blocks.filter((block) => block.kind === 'section');
    expect(slides[0]?.loc.path).toBe('outer.docx/embedded.pptx/ppt/slides/slide10.xml');
    expect(slides[0]?.blocks[0]?.loc.path).toBe('outer.docx/embedded.pptx/ppt/slides/slide10.xml');
  });

  it('matches the direct-reader golden for a LibreOffice-resaved PPTX corpus sample', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../../corpus/pptx/pptx-lo-edge-cases.pptx', import.meta.url)),
    );
    const { document } = await readBytes(bytes);
    const slides = document.blocks.filter((block) => block.kind === 'section');
    expect(slides).toHaveLength(12);
    expect(slides.map((slide) => slide.loc.slide)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
    expect(slides[0]).toMatchObject({ title: 'SmartArt and chart slide' });
    expect(slides[1]).toMatchObject({ title: 'Order and layout fixture' });
    expect(slides[2]?.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'Slide 1 content' }),
    );
    const expectedBytes = readFileSync(
      new URL('../../../../../corpus/pptx/pptx-lo-edge-cases.pptx.expected.json', import.meta.url),
    );
    const expected = JSON.parse(new TextDecoder().decode(expectedBytes)) as unknown;
    expect(document).toEqual(expected);
  });
});

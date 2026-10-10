import { readFileSync } from 'node:fs';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extract } from '../../src/core/extract.js';
import type { Block, DocsluiceDocument } from '../../src/core/model.js';
import { pptxReader } from '../../src/readers/pptx/index.js';
import { autoNumberMarker, bulletMarker } from '../../src/readers/pptx/lists.js';

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

type Section = Extract<Block, { kind: 'section' }>;

const corpus = new URL('../../../../corpus/pptx/', import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, corpus)));

/** A deck whose slides are given as `p:spTree` contents, in order. */
function deck(slides: string[]): Uint8Array {
  const files = Object.create(null) as Record<string, Uint8Array>;
  files['[Content_Types].xml'] = strToU8(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>',
  );
  files['_rels/.rels'] = strToU8(
    `<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
  );
  files['ppt/presentation.xml'] = strToU8(
    `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="s${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
  );
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    `<Relationships xmlns="${PKG}">${slides.map((_, index) => `<Relationship Id="s${index + 1}" Type="${R}/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
  );
  slides.forEach((spTree, index) => {
    files[`ppt/slides/slide${index + 1}.xml`] = strToU8(
      `<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}"><p:cSld><p:spTree>${spTree}</p:spTree></p:cSld></p:sld>`,
    );
  });
  return zipSync(files, { mtime: new Date('1980-01-01T00:00:00Z') });
}

const text = (value: string, x: number, y: number) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="t"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1" cy="1"/></a:xfrm></p:spPr><p:txBody><a:p><a:r><a:t>${value}</a:t></a:r></a:p></p:txBody></p:sp>`;

function slides(doc: DocsluiceDocument): Section[] {
  return doc.blocks.filter((block): block is Section => block.kind === 'section');
}

function texts(section: Section): string[] {
  return section.blocks.map((block) => ('text' in block ? block.text : block.kind));
}

describe('PPTX reader', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is registered for PPTX packages', async () => {
    expect(pptxReader.id).toBe('pptx');
    const doc = await extract(deck([text('one', 0, 0)]));
    expect(doc.format).toBe('pptx');
  });

  it('takes slide order from sldIdLst, not part names (PPT-1)', async () => {
    const doc = await extract(fixture('reading-order.pptx'));
    expect(slides(doc).map((section) => [section.loc.slide, section.loc.path, section.title])).toEqual([
      [1, 'ppt/slides/slide10.xml', 'Estuary Monitoring 2026'],
      [2, 'ppt/slides/slide2.xml', 'Two columns'],
      [3, 'ppt/slides/slide1.xml', 'Groups and tables'],
      [4, 'ppt/slides/slide3.xml', 'Process'],
    ]);
  });

  it('turns the title placeholder into the section title and a heading (PPT-2)', async () => {
    const [first] = slides(await extract(fixture('reading-order.pptx')));
    expect(first!.blocks[0]).toMatchObject({
      kind: 'heading',
      level: 1,
      text: 'Estuary Monitoring 2026',
      loc: { slide: 1, path: 'ppt/slides/slide10.xml' },
    });
    expect(texts(first!)).toEqual(['Estuary Monitoring 2026', 'Field season review']);
  });

  it('reads two columns left then right using layout positions, with bullets and numbering (PPT-3)', async () => {
    const second = slides(await extract(fixture('reading-order.pptx')))[1]!;
    const lists = second.blocks.filter((block) => block.kind === 'list');
    expect(lists[0]).toMatchObject({
      ordered: false,
      items: [{ text: 'Left column point', marker: '•', items: [{ text: 'Left detail', marker: '•' }] }],
    });
    expect(second.blocks[2]).toMatchObject({ kind: 'paragraph', text: 'A note without a bullet' });
    expect(lists[1]).toMatchObject({
      items: [{ text: 'Right column point', items: [{ text: 'Right detail' }] }],
    });
    expect(lists[2]).toMatchObject({
      ordered: true,
      items: [
        { text: 'Collect', marker: '1.' },
        { text: 'Label', marker: '2.', items: [{ text: 'Duplicate', marker: 'a)' }] },
        { text: 'Ship', marker: '3.' },
      ],
    });
    expect(lists[3]).toMatchObject({
      items: [
        { text: 'Tide logged', marker: '✓' },
        { text: 'Gauge read', marker: '–' },
      ],
    });
  });

  it('applies group transforms before sorting, and reads tables with spans', async () => {
    const third = slides(await extract(fixture('reading-order.pptx')))[2]!;
    expect(texts(third)).toEqual([
      'Groups and tables',
      'table',
      'Group upper item',
      'Between the group items',
      'Group lower item',
    ]);
    expect(third.blocks[1]).toMatchObject({
      kind: 'table',
      headerRows: 1,
      rows: [
        [{ text: 'Site' }, { text: 'Readings', colSpan: 2 }, { text: '' }],
        [{ text: 'North', rowSpan: 2 }, { text: '7.1' }, { text: '7.3' }],
        [{ text: '' }, { text: '6.9' }, { text: '7.0' }],
      ],
    });
  });

  it('reads SmartArt as a nested list, uses mc:Fallback, keeps footers and skips generated placeholders', async () => {
    const fourth = slides(await extract(fixture('reading-order.pptx')))[3]!;
    expect(fourth.blocks[1]).toMatchObject({
      kind: 'list',
      items: [{ text: 'Plan' }, { text: 'Sample', items: [{ text: 'Core samples' }] }, { text: 'Report' }],
    });
    expect(texts(fourth)).toEqual(['Process', 'list', 'Fallback text', 'Synthetic data only']);
    expect(fourth.blocks[3]!.kind).toBe('footer');
    expect(JSON.stringify(fourth)).not.toContain('skipped');
  });

  it('keeps ties in document order and puts unplaced shapes last', async () => {
    const unplaced =
      '<p:sp><p:nvSpPr><p:cNvPr id="3" name="u"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:p><a:r><a:t>unplaced</a:t></a:r></a:p></p:txBody></p:sp>';
    const doc = await extract(
      deck([`${unplaced}${text('b', 10, 5)}${text('a', 10, 5)}${text('top', 99, 1)}`]),
    );
    expect(texts(slides(doc)[0]!)).toEqual(['top', 'b', 'a', 'unplaced']);
  });

  it('stops groups nested 1,000 deep at blockDepth', async () => {
    const group = (inner: string) =>
      `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="g"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1" y="1"/><a:ext cx="2" cy="2"/><a:chOff x="0" y="0"/><a:chExt cx="1" cy="1"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`;
    let nested = text('deep', 0, 0);
    for (let depth = 0; depth < 1000; depth++) nested = group(nested);
    const started = performance.now();
    const doc = await extract(deck([`${text('before', 0, 0)}${nested}`]));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(doc.warnings.map((warning) => warning.code)).toContain('DEPTH_LIMIT');
    expect(texts(slides(doc)[0]!)).toContain('before');
  });

  it('keeps an unreadable slide as an empty section and never fetches', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const bytes = deck([text('one', 0, 0), text('two', 0, 0)]);
    const { unzipSync } = await import('fflate');
    const files = unzipSync(bytes);
    delete files['ppt/slides/slide1.xml'];
    const doc = await extract(zipSync(files));
    expect(slides(doc).map((section) => section.blocks.length)).toEqual([0, 1]);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts table cells against the cells limit', async () => {
    const row = `<a:tr>${'<a:tc><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc>'.repeat(10)}</a:tr>`;
    const table = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="t"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="0" y="0"/><a:ext cx="1" cy="1"/></p:xfrm><a:graphic><a:graphicData uri="t"><a:tbl>${row.repeat(10)}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
    const doc = await extract(deck([table]), { limits: { cells: 25 } });
    expect(doc.stats.truncated).toBe(true);
    const found = slides(doc)[0]!.blocks[0] as Extract<Block, { kind: 'table' }>;
    expect(found.rows.flat()).toHaveLength(25);
  });
});

describe('PPTX markers', () => {
  it.each([
    ['arabicPeriod', 3, '3.'],
    ['arabicParenR', 3, '3)'],
    ['arabicParenBoth', 3, '(3)'],
    ['arabicPlain', 3, '3'],
    ['alphaLcParenR', 28, 'bb)'],
    ['alphaUcPeriod', 1, 'A.'],
    ['romanLcPeriod', 4, 'iv.'],
    ['romanUcParenBoth', 9, '(IX)'],
    ['circleNumDbPlain', 2, '2.'],
  ])('%s %i → %s', (type, value, marker) => {
    expect(autoNumberMarker(type, value)).toBe(marker);
  });

  it('maps private-use and symbol-font bullets', () => {
    expect(bulletMarker('', false)).toBe('•');
    expect(bulletMarker('§', true)).toBe('▪');
    expect(bulletMarker('§', false)).toBe('§');
    expect(bulletMarker(undefined, false)).toBe('•');
  });
});

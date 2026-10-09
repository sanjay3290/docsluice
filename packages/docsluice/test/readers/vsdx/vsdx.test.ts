import { readFileSync } from 'node:fs';
import { zipSync, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { AbortError, LimitExceededError } from '../../../src/core/errors.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { createExtractor } from '../../../src/core/extract.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ExtractOptions, ResolvedOptions } from '../../../src/core/options.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { vsdxReader } from '../../../src/readers/vsdx/index.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../../../corpus/vsdx/${name}`, import.meta.url)));

function extractor() {
  const registry = new ReaderRegistry();
  registry.add({
    id: 'vsdx',
    mimeTypes: vsdxReader.mimeTypes,
    load: () => Promise.resolve(vsdxReader),
  });
  return createExtractor(registry);
}

const extract = (name: string, options: ExtractOptions = {}) =>
  extractor()(fixture(name), { format: 'vsdx', ...options });

function replacePart(name: string, part: string, content: string): Uint8Array {
  const entries = unzipSync(fixture(name));
  entries[part] = new TextEncoder().encode(content);
  return zipSync(entries, { level: 0 });
}

function directContext(
  bytes: Uint8Array,
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  onLimit: 'throw' | 'truncate' = 'throw',
): { ctx: ReadContext; out: DocBuilder; warnings: WarningSink; budget: Budget } {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { onLimit, warnings });
  const options: ResolvedOptions = {
    limits: budget.limits,
    onLimit,
    strict: false,
    metadata: true,
    children: 'skip',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const out = new DocBuilder(vsdxReader.id, vsdxReader.mimeTypes[0]!, budget, options);
  const ctx: ReadContext = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
  };
  return { ctx, out, warnings, budget };
}

describe('private VSDX reader', () => {
  it('reads pages in declared order through relationships and preserves shape text order', async () => {
    const doc = await extract('tiny-flow.vsdx');
    expect(doc.format).toBe('vsdx');
    // Forced private format has no public MIME mapping yet; pipeline supplies its generic fallback.
    expect(doc.mimeType).toBe('application/octet-stream');
    expect(doc.blocks).toEqual([
      {
        kind: 'section',
        role: 'page',
        title: '01 — Opening',
        loc: { page: 1, pageLabel: '01 — Opening', offset: [0, 67] },
        blocks: [
          {
            kind: 'paragraph',
            text: 'Start\nCafé Δ — 終わり & continue',
            loc: { page: 1, pageLabel: '01 — Opening', offset: [0, 29] },
          },
          {
            kind: 'paragraph',
            text: 'Grouped child α',
            loc: { page: 1, pageLabel: '01 — Opening', offset: [31, 46] },
          },
          {
            kind: 'paragraph',
            text: 'Nested\nline',
            loc: { page: 1, pageLabel: '01 — Opening', offset: [48, 59] },
          },
          {
            kind: 'paragraph',
            text: 'Finish',
            loc: { page: 1, pageLabel: '01 — Opening', offset: [61, 67] },
          },
        ],
      },
      {
        kind: 'section',
        role: 'page',
        title: '02 — Review',
        loc: { page: 2, pageLabel: '02 — Review', offset: [69, 87] },
        blocks: [
          {
            kind: 'paragraph',
            text: 'Second page review',
            loc: { page: 2, pageLabel: '02 — Review', offset: [69, 87] },
          },
        ],
      },
    ]);
    expect(doc.blocks.some((block) => block.kind === 'paragraph')).toBe(false);
  });

  it('emits static feature and core properties from shared OOXML helpers', async () => {
    const rootRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDocument" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/><Relationship Id="remote" Type="http://example.test/external" Target="https://example.test/template" TargetMode="External"/></Relationships>`;
    const coreProps = `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"><dc:title>Synthetic overview</dc:title><dcterms:created>2024-02-29T03:04:05Z</dcterms:created></cp:coreProperties>`;
    // External relationships are observed but never followed.
    const entries = unzipSync(fixture('tiny-flow.vsdx'));
    entries['_rels/.rels'] = new TextEncoder().encode(rootRels);
    entries['docProps/core.xml'] = new TextEncoder().encode(coreProps);
    const metadata = await extractor()(zipSync(entries, { level: 0 }), { format: 'vsdx' });
    expect(metadata.metadata).toMatchObject({
      title: 'Synthetic overview',
      created: '2024-02-29T03:04:05.000Z',
    });
    expect(metadata.features.hasExternalLinks).toBe(true);
    expect(metadata.blocks.length).toBe(2);
  });

  it('reports missing and traversal relationship targets without following them', async () => {
    const missing = await extract('missing-relationship.vsdx');
    expect(missing.blocks).toHaveLength(1);
    expect(missing.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    const traversal = await extract('traversal-part.vsdx');
    expect(traversal.blocks).toHaveLength(1);
    expect(traversal.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(traversal.warnings)).not.toContain('outside.xml');
  });

  it('skips repeated shape IDs within the same Shapes collection', async () => {
    const doc = await extract('duplicate-id.vsdx');
    const text = doc.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(text).not.toContain('Finish');
    expect(text).toContain('Start\nCafé Δ — 終わり & continue');
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('normalizes unsigned shape IDs before duplicate detection', async () => {
    const entries = unzipSync(fixture('duplicate-id.vsdx'));
    const page = new TextDecoder().decode(entries['visio/pages/page2.xml']);
    entries['visio/pages/page2.xml'] = new TextEncoder().encode(
      page.replace('ID="4" Name="Finish"', 'ID="04" Name="Finish"'),
    );
    const doc = await extractor()(zipSync(entries, { level: 0 }), { format: 'vsdx' });
    const text = doc.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(text).not.toContain('Finish');
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('skips shape IDs below the normative minimum of four with a static warning', async () => {
    const page = `<PageContents xmlns="http://schemas.microsoft.com/office/visio/2011/1/core"><Shapes><Shape ID="3" Name="Reserved"><Text>Reserved ID text</Text></Shape><Shape ID="4" Name="Valid"><Text>Valid shape text</Text></Shape></Shapes></PageContents>`;
    const doc = await extractor()(replacePart('tiny-flow.vsdx', 'visio/pages/page2.xml', page), {
      format: 'vsdx',
    });
    const text = doc.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(text).toContain('Valid shape text');
    expect(text).not.toContain('Reserved ID text');
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(doc.warnings)).not.toContain('Reserved ID text');
  });

  it('extracts connector shape text without interpreting Connects records', async () => {
    const page = `<PageContents xmlns="http://schemas.microsoft.com/office/visio/2011/1/core"><Shapes><Shape ID="4" Name="Connector" Type="Shape"><Text>Connector label</Text></Shape></Shapes><Connects><Connect FromSheet="4" FromCell="BeginX" FromPart="9" ToSheet="99" ToCell="PinX" ToPart="3"/></Connects></PageContents>`;
    const doc = await extractor()(replacePart('tiny-flow.vsdx', 'visio/pages/page2.xml', page), {
      format: 'vsdx',
    });
    const serialized = JSON.stringify(doc);
    expect(serialized).toContain('Connector label');
    expect(serialized).not.toContain('Connects');
    expect(serialized).not.toContain('FromSheet');
    expect(serialized).not.toContain('ToSheet');
  });

  it('never follows an external page relationship target', async () => {
    const entries = unzipSync(fixture('tiny-flow.vsdx'));
    const relationships = new TextDecoder().decode(entries['visio/pages/_rels/pages.xml.rels']);
    entries['visio/pages/_rels/pages.xml.rels'] = new TextEncoder().encode(
      relationships.replace(
        '<Relationship Id="rIdOpen" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page2.xml"/>',
        '<Relationship Id="rIdOpen" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="https://outside.invalid/private.vsdx" TargetMode="External"/>',
      ),
    );
    const doc = await extractor()(zipSync(entries, { level: 0 }), { format: 'vsdx' });
    const titles = doc.blocks
      .filter((block) => block.kind === 'section')
      .map((block) => (block.kind === 'section' ? block.title : ''));
    const text = doc.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(titles).toEqual(['02 — Review']);
    expect(text).toEqual(['Second page review']);
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(doc.warnings)).not.toContain('outside.invalid');
    expect(JSON.stringify(doc)).not.toContain('private.vsdx');
  });

  it('preserves inline Text child content and never extracts ShapeSheet formulas', async () => {
    const entries = unzipSync(fixture('tiny-flow.vsdx'));
    const page = new TextDecoder().decode(entries['visio/pages/page2.xml']);
    entries['visio/pages/page2.xml'] = new TextEncoder().encode(
      page
        .replace(
          '<Text xml:space="preserve">Start\nCafé Δ — 終わり &amp; continue</Text>',
          '<Text xmlns:ext="urn:foreign" xml:space="preserve">Start <cp IX="0"/>line &amp; <tp IX="0"/>end <fld IX="0">field value</fld><ext:secret>Injected</ext:secret></Text>',
        )
        .replace(
          '<Shape ID="9" Name="Finish" NameU="Finish" Type="Shape"><Text>Finish</Text></Shape>',
          '<Shape ID="9" Name="Finish" NameU="Finish" Type="Shape"><Cell N="Prop" F="CALLER_UNTRUSTED" V="must not appear"/><Text>Finish</Text></Shape>',
        ),
    );
    const doc = await extractor()(zipSync(entries, { level: 0 }), { format: 'vsdx' });
    const text = doc.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(text).toContain('Start line & end field value');
    expect(text).not.toContain('Injected');
    expect(text).not.toContain('must not appear');
    expect(text).not.toContain('CALLER_UNTRUSTED');
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(doc.warnings)).not.toContain('Injected');
  });

  it('rejects multiple page relationship references as ambiguous', async () => {
    const pages = `<Pages xmlns="http://schemas.microsoft.com/office/visio/2011/1/core" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><Page ID="1" Name="Ambiguous"><Rel r:id="rIdOpen"/><Rel r:id="rIdReview"/></Page></Pages>`;
    const doc = await extractor()(replacePart('tiny-flow.vsdx', 'visio/pages/pages.xml', pages), {
      format: 'vsdx',
    });
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('rejects multiple relationship-qualified IDs on a page reference', async () => {
    const pages = `<Pages xmlns="http://schemas.microsoft.com/office/visio/2011/1/core" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:s="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><Page ID="1" Name="Ambiguous"><Rel r:id="rIdOpen" s:id="rIdReview"/></Page></Pages>`;
    const doc = await extractor()(replacePart('tiny-flow.vsdx', 'visio/pages/pages.xml', pages), {
      format: 'vsdx',
    });
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('keeps partial output when one page XML part is malformed', async () => {
    const doc = await extract('bounded-malformed.vsdx');
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[0]).toMatchObject({ kind: 'section', title: '01 — Opening' });
    expect(doc.blocks[1]).toMatchObject({ kind: 'section', title: '02 — Review', blocks: [] });
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(doc.warnings)).not.toContain('Café');
  });

  it('ignores DTD entities and rejects wrong XML namespaces', async () => {
    const hostile = await extract('xml-hostile-candidate.vsdx');
    const text = hostile.blocks
      .flatMap((block) => (block.kind === 'section' ? block.blocks : []))
      .flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
    expect(text).not.toContain('/etc/passwd');
    expect(hostile.warnings.map(({ code }) => code)).toContain('DTD_IGNORED');

    const wrongNamespace = replacePart(
      'tiny-flow.vsdx',
      'visio/pages/pages.xml',
      '<Pages xmlns="urn:spoof"><Page ID="1" Name="Spoof"><Rel r:id="rIdOpen"/></Page></Pages>',
    );
    const spoofed = await extractor()(wrongNamespace, { format: 'vsdx' });
    expect(spoofed.blocks).toEqual([]);
    expect(spoofed.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('obeys XML depth, output character, and abort budgets', async () => {
    const depth = await extract('tiny-flow.vsdx', { limits: { xmlDepth: 3 } });
    expect(depth.warnings.some(({ code }) => code === 'DEPTH_LIMIT' || code === 'TRUNCATED')).toBe(true);
    const output = await extract('tiny-flow.vsdx', { limits: { outputChars: 65 } });
    expect(output.stats.truncated).toBe(true);
    expect(output.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(output.blocks).toHaveLength(1);
    const controller = new AbortController();
    controller.abort();
    await expect(extract('tiny-flow.vsdx', { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);

    const duringRead = new AbortController();
    await expect(
      extractor()(fixture('tiny-flow.vsdx'), {
        format: 'vsdx',
        signal: duringRead.signal,
        transform: (block) => {
          if (block.kind === 'paragraph') duringRead.abort();
          return block;
        },
      }),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('preflights text before calling the builder when the output limit throws', async () => {
    const longText = 'sensitive text beyond budget '.repeat(4);
    const page = `<PageContents xmlns="http://schemas.microsoft.com/office/visio/2011/1/core"><Shapes><Shape ID="4"><Text>${longText}</Text></Shape></Shapes></PageContents>`;
    const { ctx, out } = directContext(
      replacePart('tiny-flow.vsdx', 'visio/pages/page2.xml', page),
      { outputChars: 32 },
      'throw',
    );
    const paragraph = vi.spyOn(out, 'paragraph');
    await expect(vsdxReader.read(ctx)).rejects.toBeInstanceOf(LimitExceededError);
    expect(paragraph).not.toHaveBeenCalled();
  });

  it('checks large page labels before copying or opening a section', async () => {
    const longName = 'x'.repeat(100_000);
    const pages = `<Pages xmlns="http://schemas.microsoft.com/office/visio/2011/1/core" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><Page ID="1" Name="${longName}"><Rel r:id="rIdOpen"/></Page></Pages>`;
    const { ctx, out } = directContext(
      replacePart('tiny-flow.vsdx', 'visio/pages/pages.xml', pages),
      { outputChars: 32 },
      'throw',
    );
    const openSection = vi.spyOn(out, 'openSection');
    await expect(vsdxReader.read(ctx)).rejects.toBeInstanceOf(LimitExceededError);
    expect(openSection).not.toHaveBeenCalled();
  });

  it('continues reading a parent when only child-depth truncation was reported', async () => {
    const { ctx, out, budget, warnings } = directContext(fixture('tiny-flow.vsdx'), { childDepth: 0 });
    expect(budget.enterDepth('child')).toBe(false);
    budget.exitDepth('child');
    expect(budget.canRead).toBe(true);
    expect(budget.truncated).toBe(true);
    await vsdxReader.read(ctx);
    expect(warnings.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
    expect(out.finish().blocks).toHaveLength(2);
  });

  it('honors metadata false for package properties', async () => {
    const entries = unzipSync(fixture('tiny-flow.vsdx'));
    entries['docProps/core.xml'] = new TextEncoder().encode(
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Private title</dc:title><dc:creator>Writer</dc:creator></cp:coreProperties>',
    );
    const doc = await extractor()(zipSync(entries, { level: 0 }), { format: 'vsdx', metadata: false });
    expect(doc.metadata).toEqual({});
    expect(doc.blocks).toHaveLength(2);
  });

  it('rejects wrong declared content types for pages and page content parts', async () => {
    const wrongPageType = replacePart(
      'tiny-flow.vsdx',
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/><Override PartName="/visio/pages/page1.xml" ContentType="application/xml"/><Override PartName="/visio/pages/page2.xml" ContentType="application/xml"/></Types>`,
    );
    const pageDoc = await extractor()(wrongPageType, { format: 'vsdx' });
    expect(pageDoc.blocks).toEqual([]);
    expect(pageDoc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');

    const wrongPagesType = replacePart(
      'tiny-flow.vsdx',
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/><Override PartName="/visio/pages/pages.xml" ContentType="application/xml"/><Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/><Override PartName="/visio/pages/page2.xml" ContentType="application/vnd.ms-visio.page+xml"/></Types>`,
    );
    const pagesDoc = await extractor()(wrongPagesType, { format: 'vsdx' });
    expect(pagesDoc.blocks).toEqual([]);
    expect(pagesDoc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('rejects an absent document relationship without opening arbitrary package parts', async () => {
    const withoutDocument = replacePart(
      'tiny-flow.vsdx',
      '_rels/.rels',
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="notDocument" Type="http://example.test/other" Target="visio/document.xml"/></Relationships>',
    );
    const doc = await extractor()(withoutDocument, { format: 'vsdx' });
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('balances a page section when output budget rejects its title', async () => {
    const longName = 'page'.repeat(24);
    const pages = `<Pages xmlns="http://schemas.microsoft.com/office/visio/2011/1/core" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><Page ID="1" Name="${longName}"><Rel r:id="rIdOpen"/></Page></Pages>`;
    const entries = unzipSync(fixture('tiny-flow.vsdx'));
    entries['visio/pages/pages.xml'] = new TextEncoder().encode(pages);
    entries['visio/pages/page2.xml'] = new TextEncoder().encode(
      '<PageContents xmlns="http://schemas.microsoft.com/office/visio/2011/1/core"><Shapes/></PageContents>',
    );
    const doc = await extractor()(zipSync(entries, { level: 0 }), {
      format: 'vsdx',
      limits: { outputChars: 32 },
    });
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(doc.blocks).toEqual([]);
  });

  it('does not accept a spoofed relationship namespace on page references', async () => {
    const spoofed = replacePart(
      'tiny-flow.vsdx',
      'visio/pages/pages.xml',
      `<Pages xmlns="http://schemas.microsoft.com/office/visio/2011/1/core" xmlns:r="urn:spoof"><Page ID="1" Name="Spoof"><Rel r:id="rIdOpen"/></Page></Pages>`,
    );
    const doc = await extractor()(spoofed, { format: 'vsdx' });
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });
});

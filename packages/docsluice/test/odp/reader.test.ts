import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { ReadContext } from '../../src/core/reader.js';
import { WarningSink } from '../../src/core/warnings.js';
import { openZip } from '../../src/zip/index.js';
import { makeZip } from '../helpers/zip.js';
import { fuzzOdp } from '../../fuzz/odp.fuzz.js';
import { odpReader } from '../../src/readers/odp/index.js';

const encoder = new TextEncoder();
const officeNs = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const drawNs = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const presentationNs = 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0';
const textNs = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const tableNs = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const svgNs = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const xlinkNs = 'http://www.w3.org/1999/xlink';
const manifestNs = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';

function context(bytes: Uint8Array, optionOverrides: Record<string, unknown> = {}) {
  const warnings = new WarningSink({ strict: optionOverrides.strict as boolean | undefined });
  const budget = new Budget(
    { ...DEFAULT_LIMITS, ...(optionOverrides.limits as Partial<typeof DEFAULT_LIMITS> | undefined) },
    { warnings, signal: optionOverrides.signal as AbortSignal | undefined },
  );
  const out = new DocBuilder('odp', 'application/vnd.oasis.opendocument.presentation', budget, {
    metadata: true,
    runs: true,
    ...optionOverrides,
  });
  const ctx = {
    bytes,
    options: { metadata: true, runs: true, includeHidden: false, ...optionOverrides },
    budget,
    warnings,
    out,
    path: '',
    extractChild: () => Promise.resolve(),
  } as unknown as ReadContext;
  return { ctx, out, budget, warnings };
}

function packageBytes(content: string, extra: Array<{ name: string; data: string }> = []): Uint8Array {
  return makeZip([
    { name: 'mimetype', data: encoder.encode('application/vnd.oasis.opendocument.presentation') },
    { name: 'content.xml', data: encoder.encode(content) },
    ...extra.map(({ name, data }) => ({ name, data: encoder.encode(data) })),
  ]);
}

function content(body: string): string {
  return `<office:document-content xmlns:office="${officeNs}" xmlns:draw="${drawNs}" xmlns:presentation="${presentationNs}" xmlns:text="${textNs}" xmlns:table="${tableNs}" xmlns:svg="${svgNs}" xmlns:xlink="${xlinkNs}"><office:body><office:presentation>${body}</office:presentation></office:body></office:document-content>`;
}

async function extract(bytes: Uint8Array, options: Record<string, unknown> = {}) {
  const state = context(bytes, options);
  await odpReader.read(state.ctx);
  return { document: state.out.finish(), warnings: state.warnings.warnings, budget: state.budget };
}

describe('ODP reader', () => {
  it('survives arbitrary malformed bytes through its bounded fuzz entry point', async () => {
    await expect(fuzzOdp(new Uint8Array([0, 1, 2, 3, 0xff]))).resolves.toBeUndefined();
  });

  it('uses draw:page document order, title frames, coordinate order and warns for included hidden slides', async () => {
    const fixture = readFileSync(new URL('./fixtures/odp_order_hidden.odp', import.meta.url));
    const { document } = await extract(fixture);
    expect(document.blocks.map((block) => block.kind)).toEqual(['section', 'section']);
    const [first, second] = document.blocks;
    expect(first).toMatchObject({
      kind: 'section',
      role: 'slide',
      title: 'First in document order',
      hidden: true,
      loc: { slide: 1 },
      blocks: [
        { kind: 'paragraph', text: 'Earlier position, later reading item' },
        { kind: 'note', role: 'speaker-notes', text: 'Speaker notes' },
      ],
    });
    expect(second).toMatchObject({
      kind: 'section',
      role: 'slide',
      title: 'Second slide',
      hidden: false,
      loc: { slide: 2 },
    });
    expect(document.warnings.map(({ code }) => code)).toContain('HIDDEN_CONTENT');
    const withHiddenOption = await extract(fixture, { includeHidden: true });
    expect(withHiddenOption.document.blocks).toEqual(document.blocks);
  });

  it('resolves ODF element and attribute namespaces independently of their prefixes', async () => {
    const xml = `<o:document-content xmlns:o="${officeNs}" xmlns:d="${drawNs}" xmlns:p="${presentationNs}" xmlns:s="${svgNs}" xmlns:x="urn:wrong" xmlns:dc="http://purl.org/dc/elements/1.1/"><o:body><o:presentation><d:page><d:frame x:class="body" p:class="title" s:x="0cm" s:y="0cm"><d:text-box><dc:title>Ordinary extension data</dc:title><text:p xmlns:text="${textNs}">Actual title</text:p></d:text-box></d:frame></d:page></o:presentation></o:body></o:document-content>`;
    const { document } = await extract(packageBytes(xml));
    expect(document.blocks[0]).toMatchObject({ kind: 'section', title: 'Actual title' });
  });

  it('reads slide frames by position, grouped shapes, text, lists and merged table cells', async () => {
    const bytes = packageBytes(
      content(`
        <draw:page>
          <draw:g svg:x="1cm" svg:y="2cm">
            <draw:frame svg:x="3cm" svg:y="2cm"><draw:text-box><text:p>Group later</text:p></draw:text-box></draw:frame>
            <draw:frame svg:x="1cm" svg:y="1cm"><draw:text-box><text:p>Group first</text:p></draw:text-box></draw:frame>
          </draw:g>
          <draw:frame svg:x="2cm" svg:y="1cm"><draw:text-box><text:list><text:list-item><text:p>One</text:p></text:list-item></text:list></draw:text-box></draw:frame>
          <draw:frame svg:x="1cm" svg:y="4cm"><draw:text-box><table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>A</text:p></table:table-cell><table:covered-table-cell/></table:table-row></table:table></draw:text-box></draw:frame>
        </draw:page>`),
    );
    const { document } = await extract(bytes);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [
        { kind: 'list', items: [{ text: 'One' }] },
        { kind: 'paragraph', text: 'Group first' },
        {
          kind: 'table',
          rows: [[{ text: 'A', colSpan: 2 }, { text: '' }]],
        },
        { kind: 'paragraph', text: 'Group later' },
      ],
    });
  });

  it('keeps notes in their slide and does not duplicate note text into body content', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame presentation:class="title"><draw:text-box><text:p>Title</text:p></draw:text-box></draw:frame><draw:frame><draw:text-box><text:p>Body</text:p></draw:text-box></draw:frame><presentation:notes><draw:frame><draw:text-box><text:p>Presenter only</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>`,
      ),
    );
    const { document } = await extract(bytes);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      title: 'Title',
      blocks: [
        { kind: 'paragraph', text: 'Body' },
        { kind: 'note', role: 'speaker-notes', text: 'Presenter only' },
      ],
    });
  });

  it('reads text headings and emits notes only when they contain text', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame><draw:text-box><text:h text:outline-level="3">Nested heading</text:h></draw:text-box></draw:frame><presentation:notes/><presentation:notes><text:p>Only note</text:p></presentation:notes></draw:page>`,
      ),
    );
    const { document } = await extract(bytes);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [
        { kind: 'heading', level: 3, text: 'Nested heading' },
        { kind: 'note', role: 'speaker-notes', text: 'Only note' },
      ],
    });
  });

  it('retains nested list items and nested table row containers', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame><draw:text-box><text:list><text:list-item><text:p>Parent</text:p><text:list><text:list-item><text:p>Child</text:p></text:list-item></text:list></text:list-item></text:list><table:table><table:table-header-rows><table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>Header</text:p></table:table-cell><table:unknown/></table:table-row></table:table-header-rows><table:table-rows><table:table-row><table:table-cell table:number-columns-spanned="bad"><text:p>Value</text:p></table:table-cell></table:table-row></table:table-rows></table:table></draw:text-box></draw:frame></draw:page>`,
      ),
    );
    const { document } = await extract(bytes);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [
        { kind: 'list', items: [{ text: 'Parent', items: [{ text: 'Child' }] }] },
        {
          kind: 'table',
          headerRows: 1,
          rows: [[{ text: 'Header', rowSpan: 2 }], [{ text: 'Value' }]],
        },
      ],
    });
  });

  it('extracts images with accessible text, intrinsic dimensions and a listed exact-key child', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame svg:width="2cm" svg:height="3cm"><svg:title>Frame title</svg:title><svg:desc>Frame description</svg:desc><draw:image xlink:href="Pictures/one.png"/></draw:frame></draw:page>`,
      ),
      [{ name: 'Pictures/one.png', data: 'PNG bytes are opaque' }],
    );
    const { document } = await extract(bytes);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [{ kind: 'image', alt: 'Frame description', width: 76, height: 113, ref: 'Pictures/one.png' }],
    });
    expect(document.children).toMatchObject([
      { name: 'one.png', path: 'Pictures/one.png', status: 'listed', mimeType: 'image/png' },
    ]);
  });

  it('includes image child bytes when the option is enabled', async () => {
    const bytes = packageBytes(
      content(
        '<draw:page><draw:frame><draw:image xlink:href="Pictures/pixel.png"/></draw:frame></draw:page>',
      ),
      [{ name: 'Pictures/pixel.png', data: 'raw image bytes' }],
    );
    const { document } = await extract(bytes, { childBytes: true });
    expect(document.children[0]?.bytes).toEqual(encoder.encode('raw image bytes'));
  });

  it('retains text directly inside a draw custom shape', async () => {
    const bytes = packageBytes(
      content(
        '<draw:page><draw:custom-shape><text:p>Custom shape text</text:p></draw:custom-shape></draw:page>',
      ),
    );
    const { document } = await extract(bytes);
    expect(document.blocks).toMatchObject([
      { kind: 'section', blocks: [{ kind: 'paragraph', text: 'Custom shape text' }] },
    ]);
  });

  it('only discovers pages under the direct office body presentation chain', async () => {
    const extNs = 'urn:example:extension';
    const bytes = packageBytes(
      `<office:document-content xmlns:office="${officeNs}" xmlns:draw="${drawNs}" xmlns:presentation="${presentationNs}" xmlns:text="${textNs}" xmlns:ext="${extNs}"><office:body><office:presentation><draw:page><draw:frame><draw:text-box><text:p>Real slide</text:p></draw:text-box></draw:frame></draw:page></office:presentation><ext:container><office:presentation><draw:page><draw:frame><draw:text-box><text:p>False slide</text:p></draw:text-box></draw:frame></draw:page></office:presentation></ext:container></office:body></office:document-content>`,
    );
    const { document } = await extract(bytes);
    expect(document.blocks).toMatchObject([
      { kind: 'section', loc: { slide: 1 }, blocks: [{ kind: 'paragraph', text: 'Real slide' }] },
    ]);
  });

  it('keeps package hrefs literal and derives common image types from the exact part suffix', async () => {
    const names = ['a.jpg', 'b.gif', 'c.svg', 'd.webp', 'e.tif', 'f.bin', 'Pictures/%GG.png'];
    const frames = names
      .map((name) => `<draw:frame><draw:image xlink:href="${name}"/></draw:frame>`)
      .join('');
    const bytes = packageBytes(
      content(`<draw:page>${frames}</draw:page>`),
      names.map((name) => ({ name, data: 'image bytes' })),
    );
    const { document } = await extract(bytes);
    expect(document.children.map(({ path }) => path)).toEqual(names);
    expect(document.children.map(({ mimeType }) => mimeType)).toEqual([
      'image/jpeg',
      'image/gif',
      'image/svg+xml',
      'image/webp',
      'image/tiff',
      undefined,
      'image/png',
    ]);
  });

  it('records external hyperlinks without following them and keeps inline runs when requested', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame><draw:text-box><text:p>Read:<text:a xlink:type="simple" xlink:href="https://example.invalid/"> the source</text:a>.</text:p></draw:text-box></draw:frame></draw:page>`,
      ),
    );
    const { document } = await extract(bytes, { runs: true });
    expect(document.features.hasExternalLinks).toBe(true);
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [
        {
          kind: 'paragraph',
          text: 'Read: the source.',
          runs: [{ text: 'Read:' }, { text: ' the source', href: 'https://example.invalid/' }, { text: '.' }],
        },
      ],
    });
  });

  it('never resolves external or traversal image hrefs to archive children', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame><draw:image xlink:href="../secret.png"/><draw:image xlink:href="Pictures/%2e%2e/secret.png"/><draw:image xlink:href="/absolute.png"/></draw:frame><draw:frame><draw:image xlink:href="https://example.invalid/image.png"/></draw:frame></draw:page>`,
      ),
      [
        { name: 'secret.png', data: 'must not be referenced' },
        { name: 'image.png', data: 'must not be fetched' },
      ],
    );
    const { document } = await extract(bytes);
    expect(document.features.hasExternalLinks).toBe(true);
    expect(document.children).toEqual([]);
    expect(document.blocks[0]?.kind).toBe('section');
    if (document.blocks[0]?.kind === 'section') {
      expect(document.blocks[0].blocks).toHaveLength(4);
      for (const block of document.blocks[0].blocks) {
        expect(block.kind).toBe('image');
        expect(block).not.toHaveProperty('ref');
      }
    }
  });

  it('rejects duplicate exact content part names deterministically', async () => {
    const bytes = makeZip([
      { name: 'content.xml', data: encoder.encode(content('<draw:page/>')) },
      { name: 'content.xml', data: encoder.encode(content('<draw:page/>')) },
    ]);
    const state = context(bytes);
    await expect(odpReader.read(state.ctx)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
    expect(state.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('reports missing and invalid package content without echoing source text', async () => {
    const missing = makeZip([
      {
        name: 'mimetype',
        data: encoder.encode('application/vnd.oasis.opendocument.presentation'),
      },
    ]);
    await expect(odpReader.read(context(missing).ctx)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
    const invalid = packageBytes('<not-odf>secret text</not-odf>');
    await expect(odpReader.read(context(invalid).ctx)).rejects.toMatchObject({
      code: 'CORRUPT_FILE',
      message: 'ODP presentation content is invalid.',
    });
  });

  it('respects shared abort and output-character budgets', async () => {
    const controller = new AbortController();
    controller.abort();
    const bytes = packageBytes(
      content(
        '<draw:page><draw:frame><draw:text-box><text:p>Bounded text</text:p></draw:text-box></draw:frame></draw:page>',
      ),
    );
    await expect(odpReader.read(context(bytes, { signal: controller.signal }).ctx)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    const state = context(bytes, { limits: { outputChars: 0 } });
    await odpReader.read(state.ctx);
    expect(state.out.finish().stats.truncated).toBe(true);
    expect(state.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('bounds table-cell work using the shared cell budget', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><draw:frame><draw:text-box><table:table><table:table-row><table:table-cell><text:p>First</text:p></table:table-cell><table:table-cell><text:p>Skipped</text:p></table:table-cell></table:table-row></table:table></draw:text-box></draw:frame></draw:page>`,
      ),
    );
    const state = context(bytes, { limits: { cells: 1 } });
    await odpReader.read(state.ctx);
    const document = state.out.finish();
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [{ kind: 'table', rows: [[{ text: 'First' }]] }],
    });
    expect(document.stats.truncated).toBe(true);
    expect(document.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('lets the shared builder flatten slides at its block-depth limit', async () => {
    const bytes = packageBytes(
      content(
        '<draw:page><draw:frame><draw:text-box><text:p>Flattened slide</text:p></draw:text-box></draw:frame></draw:page>',
      ),
    );
    const state = context(bytes, { limits: { blockDepth: 0 } });
    await odpReader.read(state.ctx);
    const document = state.out.finish();
    expect(document.blocks).toMatchObject([{ kind: 'paragraph', text: 'Flattened slide' }]);
    expect(document.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });

  it('applies strict warning policy to hidden slides', async () => {
    const fixture = readFileSync(new URL('./fixtures/odp_order_hidden.odp', import.meta.url));
    await expect(odpReader.read(context(fixture, { strict: true }).ctx)).rejects.toMatchObject({
      code: 'STRICT_WARNING',
      warningCode: 'HIDDEN_CONTENT',
    });
  });

  it('rejects encrypted ODF package parts before reading them', async () => {
    const bytes = packageBytes(
      content(
        '<draw:page><draw:frame><draw:text-box><text:p>Ignored</text:p></draw:text-box></draw:frame></draw:page>',
      ),
      [
        {
          name: 'META-INF/manifest.xml',
          data: `<manifest:manifest xmlns:manifest="${manifestNs}"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>`,
        },
      ],
    );
    await expect(odpReader.read(context(bytes).ctx)).rejects.toMatchObject({ code: 'ENCRYPTED' });
  });

  it('rejects ZIP-encrypted content parts and does not try to parse them', async () => {
    const bytes = makeZip([
      {
        name: 'content.xml',
        data: encoder.encode(content('<draw:page/>')),
        flags: 0x0801,
      },
    ]);
    await expect(odpReader.read(context(bytes).ctx)).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'password-required',
    });
  });

  it('reuses the archive supplied in its read context', async () => {
    const bytes = packageBytes(content('<draw:page/>'));
    const state = context(bytes);
    const archive = openZip(bytes, state.budget);
    const entriesBefore = state.budget.entries;
    await odpReader.read({ ...state.ctx, zip: archive });
    expect(state.budget.entries).toBe(entriesBefore);
  });

  it('ignores external entities in presentation XML', async () => {
    const xml = content(
      '<draw:page><draw:frame><draw:text-box><text:p>&secret;</text:p></draw:text-box></draw:frame></draw:page>',
    ).replace(
      '<office:document-content',
      '<!DOCTYPE office:document-content [<!ENTITY secret SYSTEM "file:///private">]><office:document-content',
    );
    const { document } = await extract(packageBytes(xml));
    expect(document.blocks[0]).toMatchObject({
      kind: 'section',
      blocks: [{ kind: 'paragraph', text: '&secret;' }],
    });
    expect(document.warnings.map(({ code }) => code)).toContain('DTD_IGNORED');
  });

  it('does not expose personal metadata or note authors when metadata is disabled', async () => {
    const bytes = packageBytes(
      content(
        `<draw:page><presentation:notes><text:p>Notes</text:p><text:creator>Private note author</text:creator></presentation:notes></draw:page>`,
      ),
      [
        {
          name: 'meta.xml',
          data: `<office:document-meta xmlns:office="${officeNs}" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>Public</dc:title><dc:creator>Private author</dc:creator></office:meta></office:document-meta>`,
        },
      ],
    );
    const { document } = await extract(bytes, { metadata: false });
    expect(document.metadata).toEqual({ title: 'Public' });
    expect(document.blocks[0]?.kind).toBe('section');
    if (document.blocks[0]?.kind === 'section')
      expect(document.blocks[0].blocks[0]).not.toHaveProperty('author');
  });
});

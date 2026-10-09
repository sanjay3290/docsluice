import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { DocBuilder } from '../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import { openZip } from '../../src/zip/index.js';
import { makeZip } from '../helpers/zip.js';
import { odtReader } from '../../src/readers/odt/index.js';

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const style = 'urn:oasis:names:tc:opendocument:xmlns:style:1.0';
const table = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const draw = 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0';
const svg = 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0';
const manifest = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';

function doc(
  content: string,
  extras: Array<{ name: string; data: string | Uint8Array }> = [],
  options: Record<string, unknown> = {},
  limits = DEFAULT_LIMITS,
) {
  const bytes = makeZip([
    { name: 'mimetype', data: new TextEncoder().encode('application/vnd.oasis.opendocument.text') },
    { name: 'content.xml', data: new TextEncoder().encode(content) },
    ...extras.map(({ name, data }) => ({
      name,
      data: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    })),
  ]);
  return readBytes(bytes, options, limits);
}

function readBytes(bytes: Uint8Array, options: Record<string, unknown> = {}, limits = DEFAULT_LIMITS) {
  const warnings = new WarningSink({ strict: options.strict as boolean | undefined });
  const budget = new Budget(limits, {
    warnings,
    signal: options.signal as AbortSignal | undefined,
    onLimit: options.onLimit as 'truncate' | 'throw' | undefined,
  });
  const ctx = {
    bytes,
    options: {
      metadata: true,
      children: 'list',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: false,
      ...options,
    } as never,
    budget,
    warnings,
    out: new DocBuilder('odt', 'application/vnd.oasis.opendocument.text', budget, options),
    path: '',
    extractChild: async () => {},
    zip: openZip(bytes, budget),
  };
  return odtReader.read(ctx).then(() => ctx.out.finish());
}

const root = (body: string, children = '') =>
  `<office:document-content xmlns:office="${office}" xmlns:text="${text}" xmlns:style="${style}" xmlns:table="${table}" xmlns:draw="${draw}" xmlns:svg="${svg}"><office:automatic-styles>${children}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;

describe('ODT reader', () => {
  it('extracts the clean-room end-to-end package fixture', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/odt_blocks.odt', import.meta.url)));
    const result = await readBytes(bytes);
    expect(result.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'list',
      'table',
      'note',
      'note',
      'image',
    ]);
    expect(result.metadata.title).toBe('ODT blocks');
    expect(result.children).toMatchObject([{ name: 'pixel.png', status: 'listed', mimeType: 'image/png' }]);
  });
  it('preserves headings, paragraphs, nested lists and merged table cells', async () => {
    const result = await doc(
      root(
        `<text:h text:outline-level="2">Heading</text:h><text:p>Intro</text:p><text:list><text:list-item><text:p>One</text:p><text:list><text:list-item><text:p>Nested</text:p></text:list-item></text:list></text:list-item></text:list><table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>A</text:p></table:table-cell><table:covered-table-cell/><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );
    expect(result.blocks.map((block) => block.kind)).toEqual(['heading', 'paragraph', 'list', 'table']);
    expect(result.blocks[0]).toMatchObject({ kind: 'heading', level: 2, text: 'Heading' });
    expect(result.blocks[2]).toMatchObject({
      kind: 'list',
      items: [{ text: 'One', items: [{ text: 'Nested' }] }],
    });
    expect(result.blocks[3]).toMatchObject({
      kind: 'table',
      rows: [[{ text: 'A', colSpan: 2 }, { text: 'B' }]],
    });
  });

  it('keeps notes and annotations and strips annotation authors when metadata is disabled', async () => {
    const result = await doc(
      root(
        `<text:p>Before<text:note text:note-class="footnote"><text:note-body><text:p>Foot text</text:p></text:note-body></text:note></text:p><office:annotation office:name="x" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Author Name</dc:creator><text:p>Comment</text:p></office:annotation>`,
      ),
      [],
      { metadata: false },
    );
    expect(result.blocks).toContainEqual(
      expect.objectContaining({ kind: 'note', role: 'footnote', text: 'Foot text' }),
    );
    const annotation = result.blocks.find((block) => block.kind === 'note' && block.role === 'annotation');
    expect(annotation).toMatchObject({ kind: 'note', role: 'annotation', text: 'Comment' });
    expect(annotation).not.toHaveProperty('author');
  });

  it('lists internal images with alt text and dimensions and never fetches external links', async () => {
    const image = new Uint8Array([1, 2, 3]);
    const manifestXml = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="Pictures/p.png" manifest:media-type="image/png"/></manifest:manifest>`;
    const result = await doc(
      root(
        `<text:p><text:a xlink:href="https://example.invalid/" xmlns:xlink="http://www.w3.org/1999/xlink">link</text:a></text:p><draw:frame svg:width="2cm" svg:height="1cm"><svg:title>Diagram</svg:title><draw:image xlink:href="Pictures/p.png" xmlns:xlink="http://www.w3.org/1999/xlink"/></draw:frame>`,
      ),
      [
        { name: 'META-INF/manifest.xml', data: manifestXml },
        { name: 'Pictures/p.png', data: image },
      ],
    );
    expect(result.features.hasExternalLinks).toBe(true);
    expect(result.children).toMatchObject([
      { path: 'Pictures/p.png', status: 'listed', sizeBytes: 3, mimeType: 'image/png' },
    ]);
    expect(result.blocks).toContainEqual(
      expect.objectContaining({
        kind: 'image',
        alt: 'Diagram',
        ref: 'Pictures/p.png',
        width: 76,
        height: 38,
      }),
    );
  });

  it('rejects encrypted package entries without attempting decryption', async () => {
    const encryptedManifest = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"><manifest:encryption-data/></manifest:file-entry></manifest:manifest>`;
    await expect(
      doc(root('<text:p>secret</text:p>'), [{ name: 'META-INF/manifest.xml', data: encryptedManifest }]),
    ).rejects.toMatchObject({ code: 'ENCRYPTED', reason: 'password-required' });
  });

  it('ignores nested lookalike content outside the ODF body and warns on malformed content root', async () => {
    const result = await doc(
      `<evil xmlns:office="${office}" xmlns:text="${text}"><office:body><office:text><text:p>spoofed</text:p></office:text></office:body></evil>`,
    );
    expect(result.blocks).toEqual([]);
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'UNREADABLE_PART' }));
  });

  it('applies tracked change modes and warns without exposing hidden source text', async () => {
    const input = root(
      '<text:p>Keep <text:insertion><text:p>added</text:p></text:insertion><text:deletion><text:p>removed</text:p></text:deletion></text:p>',
    );
    const accepted = await doc(input);
    const rejected = await doc(input, [], { revisions: 'reject' });
    const shown = await doc(input, [], { revisions: 'show', runs: true });
    expect(accepted.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Keep added' });
    expect(rejected.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Keep removed' });
    expect(shown.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Keep [+added+][-removed-]' });
    expect(
      (shown.blocks[0] as { runs?: Array<{ text: string }> }).runs?.map((run) => run.text).join(''),
    ).toBe('Keep [+added+][-removed-]');
    expect(accepted.warnings).toContainEqual(expect.objectContaining({ code: 'HIDDEN_CONTENT' }));
    expect(accepted.warnings.every((warning) => !warning.message.includes('removed'))).toBe(true);
  });

  it('fails encrypted ZIP parts even when the manifest does not mark them', async () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const bytes = makeZip([
      { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>secret</text:p>')), flags: 0x0801 },
    ]);
    const ctx = {
      bytes,
      options: {
        metadata: true,
        children: 'list',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
      },
      budget,
      warnings,
      out: new DocBuilder('odt', 'application/vnd.oasis.opendocument.text', budget),
      path: '',
      extractChild: async () => {},
      zip: openZip(bytes, budget),
    };
    await expect(odtReader.read(ctx as never)).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'password-required',
    });
  });

  it('does not accept an image path until the exact manifest key and ZIP part both exist', async () => {
    const manifestXml = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="Pictures%2fp.png" manifest:media-type="image/png"/></manifest:manifest>`;
    const result = await doc(
      root(
        `<draw:frame><svg:title>Hidden ref</svg:title><draw:image xlink:href="Pictures/p.png" xmlns:xlink="http://www.w3.org/1999/xlink"/></draw:frame>`,
      ),
      [
        { name: 'META-INF/manifest.xml', data: manifestXml },
        { name: 'Pictures/p.png', data: new Uint8Array([1]) },
      ],
    );
    expect(result.children).toEqual([]);
    expect(result.blocks).toContainEqual(expect.objectContaining({ kind: 'image', alt: 'Hidden ref' }));
    expect(result.blocks.find((block) => block.kind === 'image')).not.toHaveProperty('ref');
  });

  it('uses declared numbered list styles and retains hyperlink runs when requested', async () => {
    const content = root(
      `<text:p><text:a xlink:href="https://example.invalid/" xmlns:xlink="http://www.w3.org/1999/xlink">linked</text:a><text:a xlink:href="#bookmark" xmlns:xlink="http://www.w3.org/1999/xlink">local</text:a></text:p><text:list text:style-name="ordered"><text:list-item><text:p>first</text:p></text:list-item><text:list-item><text:p>second</text:p></text:list-item></text:list>`,
      `<text:list-style style:name="ordered"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix=")"/></text:list-style>`,
    );
    const result = await doc(content, [], { runs: true });
    expect(result.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'linkedlocal',
      runs: [
        { text: 'linked', href: 'https://example.invalid/' },
        { text: 'local', href: '#bookmark' },
      ],
    });
    expect(result.blocks[1]).toMatchObject({
      kind: 'list',
      ordered: true,
      items: [
        { text: 'first', marker: '1)' },
        { text: 'second', marker: '2)' },
      ],
    });
    expect(result.features.hasExternalLinks).toBe(true);
  });

  it('flattens lists when their nesting exceeds the configured block depth', async () => {
    const limited = await doc(
      root(
        '<text:list><text:list-item><text:p>Outer</text:p><text:list><text:list-item><text:p>Inner</text:p></text:list-item></text:list></text:list-item></text:list>',
      ),
      [],
      {},
      { ...DEFAULT_LIMITS, blockDepth: 1 },
    );
    expect(limited.blocks[0]).toMatchObject({ kind: 'list', items: [{ text: 'Outer\nInner' }] });
    expect(limited.warnings).toContainEqual(expect.objectContaining({ code: 'DEPTH_LIMIT' }));
  });

  it('keeps document order across sections and ignores foreign extension subtrees', async () => {
    const content = root(
      '<text:section><text:p>First in section</text:p></text:section><evil:wrapper xmlns:evil="urn:attacker"><text:p>Forged extension text</text:p></evil:wrapper><text:p>Before<evil:wrapper xmlns:evil="urn:attacker"><text:span>Forged inline text</text:span></evil:wrapper>After</text:p><text:p>Later sibling</text:p>',
    );
    const result = await doc(content);
    expect(result.blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      'First in section',
      'BeforeAfter',
      'Later sibling',
    ]);
  });

  it('resolves tracked-change catalog markers without emitting history as body content', async () => {
    const catalog = `<text:tracked-changes><text:changed-region text:id="ct1"><text:deletion><office:change-info/><text:p>deleted paragraph</text:p></text:deletion></text:changed-region><text:changed-region text:id="ct2"><text:insertion><office:change-info/><text:p>inserted paragraph</text:p></text:insertion></text:changed-region></text:tracked-changes>`;
    const input = root(
      `${catalog}<text:p>before<text:change text:change-id="ct1"/>middle<text:change text:change-id="ct2"/>after</text:p>`,
    );
    const accepted = await doc(input);
    const rejected = await doc(input, [], { revisions: 'reject' });
    const shown = await doc(input, [], { revisions: 'show' });
    const paragraphTexts = (blocks: typeof accepted.blocks) =>
      blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''));
    expect(paragraphTexts(accepted.blocks)).toEqual(['beforemiddleinserted paragraphafter']);
    expect(paragraphTexts(rejected.blocks)).toEqual(['beforedeleted paragraphmiddleafter']);
    expect(paragraphTexts(shown.blocks)).toEqual([
      'before[-deleted paragraph-]middle[+inserted paragraph+]after',
    ]);
    expect(
      accepted.blocks.some((block) => block.kind === 'paragraph' && block.text === 'deleted paragraph'),
    ).toBe(false);
    expect(accepted.warnings).toContainEqual(expect.objectContaining({ code: 'HIDDEN_CONTENT' }));
  });

  it('resolves ODF tracked-change range markers in all revision modes', async () => {
    const catalog = `<text:tracked-changes><text:changed-region text:id="add"><text:insertion><office:change-info/></text:insertion></text:changed-region><text:changed-region text:id="remove"><text:deletion><office:change-info/><text:p>removed range</text:p></text:deletion></text:changed-region></text:tracked-changes>`;
    const input = root(
      `${catalog}<text:p>A<text:change-start text:change-id="add"/>inserted range<text:change-end text:change-id="add"/>B<text:change-start text:change-id="remove"/><text:change-end text:change-id="remove"/>C</text:p>`,
    );
    const accepted = await doc(input);
    const rejected = await doc(input, [], { revisions: 'reject' });
    const shown = await doc(input, [], { revisions: 'show', runs: true });
    expect(accepted.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Ainserted rangeBC' });
    expect(rejected.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'ABremoved rangeC' });
    expect(shown.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'A[+inserted range+]B[-removed range-]C',
    });
    expect(
      (shown.blocks[0] as { runs?: Array<{ text: string }> }).runs?.map((run) => run.text).join(''),
    ).toBe('A[+inserted range+]B[-removed range-]C');
  });

  it('runs through the standard extraction pipeline with a private ODT registry', async () => {
    const bytes = makeZip([
      { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>Pipeline ODT</text:p>')) },
    ]);
    const registry = new ReaderRegistry();
    registry.add({ id: 'odt', mimeTypes: odtReader.mimeTypes, load: () => Promise.resolve(odtReader) });
    const result = await createExtractor(registry)(bytes, { format: 'odt' });
    expect(result.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'Pipeline ODT' }),
    );
  });

  it('ignores DTD entities and returns a static warning', async () => {
    const input = `<!DOCTYPE office:document-content [<!ENTITY secret SYSTEM "file:///private/data">]>${root('<text:p>&secret;</text:p>')}`;
    const result = await doc(input);
    expect(result.blocks).toContainEqual(expect.objectContaining({ kind: 'paragraph', text: '&secret;' }));
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'DTD_IGNORED' }));
    expect(result.warnings.every((warning) => !warning.message.includes('private/data'))).toBe(true);
  });

  it('honors strict warnings, XML depth, and abort signals', async () => {
    await expect(doc('<evil/>', [], { strict: true })).rejects.toMatchObject({ code: 'STRICT_WARNING' });
    const deep = `<office:document-content xmlns:office="${office}" xmlns:text="${text}"><office:body><office:text><text:p>${'<text:span>'.repeat(8)}x${'</text:span>'.repeat(8)}</text:p></office:text></office:body></office:document-content>`;
    const limited = await doc(deep, [], {}, { ...DEFAULT_LIMITS, xmlDepth: 4 });
    expect(limited.warnings).toContainEqual(expect.objectContaining({ code: 'TRUNCATED' }));
    const controller = new AbortController();
    controller.abort();
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings, signal: controller.signal });
    const bytes = makeZip([
      { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>never read</text:p>')) },
    ]);
    const zip = openZip(bytes, new Budget(DEFAULT_LIMITS));
    const context = {
      bytes,
      options: {
        metadata: true,
        children: 'list',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
      },
      budget,
      warnings,
      out: new DocBuilder('odt', 'application/vnd.oasis.opendocument.text', budget),
      path: '',
      extractChild: async () => {},
      zip,
    };
    await expect(odtReader.read(context as never)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('warns deterministically for missing, duplicate, and unreadable package parts', async () => {
    const missing = await readBytes(
      makeZip([{ name: 'meta.xml', data: new TextEncoder().encode('<meta/>') }]),
    );
    expect(missing.warnings).toContainEqual(expect.objectContaining({ code: 'UNREADABLE_PART' }));
    const duplicateBytes = makeZip([
      { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>first</text:p>')) },
      { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>second</text:p>')) },
    ]);
    const duplicate = await readBytes(duplicateBytes);
    expect(duplicate.blocks).toEqual([]);
    expect(duplicate.warnings).toContainEqual(expect.objectContaining({ code: 'UNREADABLE_PART' }));
    const unreadable = await readBytes(
      makeZip([
        { name: 'content.xml', data: new TextEncoder().encode(root('<text:p>bad</text:p>')), method: 99 },
      ]),
    );
    expect(unreadable.blocks).toEqual([]);
    expect(unreadable.warnings).toContainEqual(expect.objectContaining({ code: 'UNREADABLE_PART' }));
  });

  it('uses styles.xml, warns when office:text is absent, and walks nested sections and tables iteratively', async () => {
    const stylesXml = `<office:document-styles xmlns:office="${office}" xmlns:style="${style}"><office:styles><style:style style:name="Chapter" style:family="paragraph"><style:paragraph-properties style:default-outline-level="3"/></style:style></office:styles></office:document-styles>`;
    const input = root(
      `<text:section><text:h text:style-name="Chapter">Styled heading</text:h><table:table><table:table-row><table:table-cell><table:table><table:table-row><table:table-cell><text:p>Nested cell</text:p></table:table-cell></table:table-row></table:table></table:table-cell></table:table-row></table:table></text:section>`,
    );
    const result = await doc(input, [{ name: 'styles.xml', data: stylesXml }]);
    expect(result.blocks[0]).toMatchObject({ kind: 'heading', level: 3, text: 'Styled heading' });
    expect(result.blocks.filter((block) => block.kind === 'table')).toHaveLength(2);
    const noText = await doc(
      `<office:document-content xmlns:office="${office}"><office:body/></office:document-content>`,
    );
    expect(noText.blocks).toEqual([]);
    expect(noText.warnings).toContainEqual(expect.objectContaining({ code: 'UNREADABLE_PART' }));
  });

  it('reads table rows in header-row wrappers and retains row spans', async () => {
    const result = await doc(
      root(
        '<table:table><table:table-header-rows><table:table-row><table:table-cell><text:p>Head</text:p></table:table-cell></table:table-row></table:table-header-rows><table:table-rows><table:table-row><table:table-cell table:number-rows-spanned="2"><text:p>Body</text:p></table:table-cell></table:table-row></table:table-rows></table:table>',
      ),
    );
    expect(result.blocks[0]).toMatchObject({
      kind: 'table',
      headerRows: 1,
      rows: [[{ text: 'Head' }], [{ text: 'Body', rowSpan: 2 }]],
    });
  });

  it('emits notes nested inside list items and table cells', async () => {
    const result = await doc(
      root(
        '<text:list><text:list-item><text:p>Item<text:note text:note-class="endnote"><text:note-body><text:p>List note</text:p></text:note-body></text:note></text:p></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>Cell<text:note text:note-class="footnote"><text:note-body><text:p>Table note</text:p></text:note-body></text:note></text:p></table:table-cell></table:table-row></table:table>',
      ),
    );
    expect(result.blocks.filter((block) => block.kind === 'note')).toMatchObject([
      { role: 'endnote', text: 'List note' },
      { role: 'footnote', text: 'Table note' },
    ]);
  });

  it('lists child bytes only by option and omits image refs when children are skipped', async () => {
    const image = new Uint8Array([4, 5]);
    const manifestXml = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="Pictures/p.png" manifest:media-type="image/png"/></manifest:manifest>`;
    const content = root(
      `<draw:frame svg:width="1em"><svg:desc>Fallback description</svg:desc><draw:image xlink:href="Pictures/p.png" xmlns:xlink="http://www.w3.org/1999/xlink"/></draw:frame>`,
    );
    const withBytes = await doc(
      content,
      [
        { name: 'META-INF/manifest.xml', data: manifestXml },
        { name: 'Pictures/p.png', data: image },
      ],
      { childBytes: true },
    );
    expect(withBytes.children[0]?.bytes).toEqual(image);
    expect(withBytes.blocks).toContainEqual(
      expect.objectContaining({ kind: 'image', alt: 'Fallback description' }),
    );
    const skipped = await doc(
      content,
      [
        { name: 'META-INF/manifest.xml', data: manifestXml },
        { name: 'Pictures/p.png', data: image },
      ],
      { children: 'skip' },
    );
    expect(skipped.children).toEqual([]);
    expect(skipped.blocks.find((block) => block.kind === 'image')).not.toHaveProperty('ref');
  });

  it('preserves explicit spaces, tabs, line breaks, and revision text in runs', async () => {
    const result = await doc(
      root(
        '<text:p>A<text:s text:c="2"/>B<text:tab/>C<text:line-break/>D<text:insertion>new</text:insertion><text:deletion>old</text:deletion></text:p>',
      ),
      [],
      { runs: true, revisions: 'accept' },
    );
    expect(result.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'A  B\tC\nDnew' });
    expect(result.warnings.filter((warning) => warning.code === 'HIDDEN_CONTENT')).toHaveLength(1);
  });

  it('ignores same-local-name attributes bound to an unrelated namespace', async () => {
    const spoofed = root(
      '<text:p>A<text:s evil:c="4" xmlns:evil="urn:attacker"/></text:p><table:table><table:table-row><table:table-cell evil:number-columns-spanned="9" xmlns:evil="urn:attacker"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table>',
    );
    const result = await doc(spoofed);
    expect(result.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'A' });
    expect(result.blocks[1]).toMatchObject({ kind: 'table', rows: [[{ text: 'Cell' }]] });
  });

  it('uses list marker styles from styles.xml', async () => {
    const stylesXml = `<office:document-styles xmlns:office="${office}" xmlns:style="${style}" xmlns:text="${text}"><office:styles><text:list-style style:name="alpha"><text:list-level-style-number text:level="1" style:num-format="a" style:num-suffix=")"/></text:list-style></office:styles></office:document-styles>`;
    const result = await doc(
      root(
        '<text:list text:style-name="alpha"><text:list-item><text:p>First</text:p></text:list-item><text:list-item><text:p>Second</text:p></text:list-item></text:list>',
      ),
      [{ name: 'styles.xml', data: stylesXml }],
    );
    expect(result.blocks[0]).toMatchObject({
      kind: 'list',
      ordered: true,
      items: [{ marker: 'a)' }, { marker: 'b)' }],
    });
  });

  it('rejects encrypted image bytes and skips non-cell table content', async () => {
    const manifestXml = `<manifest:manifest xmlns:manifest="${manifest}"><manifest:file-entry manifest:full-path="Pictures/p.png" manifest:media-type="image/png"/></manifest:manifest>`;
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    const bytes = makeZip([
      { name: 'META-INF/manifest.xml', data: new TextEncoder().encode(manifestXml) },
      {
        name: 'content.xml',
        data: new TextEncoder().encode(
          root(
            '<draw:frame><draw:image xlink:href="Pictures/p.png" xmlns:xlink="http://www.w3.org/1999/xlink"/></draw:frame><table:table><table:table-row><text:p>skip</text:p></table:table-row></table:table>',
          ),
        ),
      },
      { name: 'Pictures/p.png', data: new Uint8Array([1]), flags: 0x0801 },
    ]);
    const context = {
      bytes,
      options: {
        metadata: true,
        children: 'list',
        childBytes: false,
        runs: false,
        revisions: 'accept',
        includeHidden: false,
      },
      budget,
      warnings,
      out: new DocBuilder('odt', 'application/vnd.oasis.opendocument.text', budget),
      path: '',
      extractChild: async () => {},
      zip: openZip(bytes, budget),
    };
    await expect(odtReader.read(context as never)).rejects.toMatchObject({ code: 'ENCRYPTED' });
  });
});

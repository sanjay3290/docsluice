import { describe, expect, it } from 'vitest';
import { EncryptedError } from '../../../src/core/errors.js';
import { extract } from '../../../src/core/extract.js';
import type { Block, DocsluiceDocument } from '../../../src/core/model.js';
import { lengthInMillimetres } from '../../../src/readers/odp/content.js';
import { fuzzOdp } from '../../../fuzz/odp.fuzz.js';
import { makeZip } from '../../helpers/zip.js';

const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  manifest: 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0',
};
const encode = (text: string) => new TextEncoder().encode(text);
const declarations = Object.entries(NS)
  .filter(([prefix]) => prefix !== 'manifest')
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ');

function odp(
  pages: string,
  options: { styles?: string; sharedStyles?: string; extra?: Array<{ name: string; data: Uint8Array }> } = {},
) {
  const content = `<office:document-content ${declarations}><office:automatic-styles>${options.styles ?? ''}</office:automatic-styles><office:body><office:presentation>${pages}</office:presentation></office:body></office:document-content>`;
  return makeZip([
    { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.presentation'), method: 0 },
    { name: 'content.xml', data: encode(content) },
    ...(options.sharedStyles
      ? [
          {
            name: 'styles.xml',
            data: encode(
              `<office:document-styles ${declarations}><office:styles>${options.sharedStyles}</office:styles></office:document-styles>`,
            ),
          },
        ]
      : []),
    ...(options.extra ?? []),
  ]);
}

const page = (inner: string, attrs = '') => `<draw:page ${attrs}>${inner}</draw:page>`;
const frame = (inner: string, x: string, y: string, attrs = '') =>
  `<draw:frame svg:x="${x}" svg:y="${y}" ${attrs}><draw:text-box>${inner}</draw:text-box></draw:frame>`;
const p = (text: string) => `<text:p>${text}</text:p>`;

function slides(doc: DocsluiceDocument): Block[][] {
  return doc.blocks.map((block) => (block.kind === 'section' ? block.blocks : []));
}

describe('ODP reader', () => {
  it('gives one slide section per page with the title placeholder as heading', async () => {
    const doc = await extract(
      odp(
        page(
          frame(p('Body text'), '2cm', '5cm') +
            frame(p('Main') + p('Title'), '2cm', '1cm', 'presentation:class="title"'),
        ) + page(frame(p('No title here'), '1cm', '1cm')),
      ),
      { filename: 'deck.odp' },
    );
    expect(doc.format).toBe('odp');
    expect(doc.blocks[0]).toMatchObject({
      kind: 'section',
      role: 'slide',
      title: 'Main Title',
      loc: { slide: 1 },
    });
    expect(slides(doc)[0]).toMatchObject([
      { kind: 'heading', level: 1, text: 'Main Title' },
      { kind: 'paragraph', text: 'Body text' },
    ]);
    expect(doc.blocks[1]).toMatchObject({ kind: 'section', loc: { slide: 2 } });
    expect((doc.blocks[1] as { title?: string }).title).toBeUndefined();
  });

  it('orders shapes top to bottom, then left to right, across units and groups', async () => {
    const doc = await extract(
      odp(
        page(
          frame(p('last'), '0in', '4in') +
            `<draw:g>${frame(p('right'), '100mm', '20mm')}${frame(p('left'), '10mm', '2cm')}</draw:g>` +
            frame(p('first'), '0pt', '0pt') +
            frame(p('unplaced'), 'x', 'y') +
            `<draw:custom-shape svg:x="1cm" svg:y="3cm">${p('custom shape')}</draw:custom-shape>`,
        ),
      ),
    );
    expect(slides(doc)[0]!.map((block) => (block.kind === 'paragraph' ? block.text : block.kind))).toEqual([
      'first',
      'left',
      'right',
      'custom shape',
      'last',
      'unplaced',
    ]);
  });

  it('turns text:list into lists with bullet and number markers from list styles', async () => {
    const listStyles =
      '<text:list-style style:name="B"><text:list-level-style-bullet text:level="1" text:bullet-char="➢"/><text:list-level-style-bullet text:level="2" text:bullet-char="&#xE000;"/></text:list-style>' +
      '<text:list-style style:name="N"><text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix="."/><text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=")" text:start-value="3"/></text:list-style>' +
      '<text:list-style style:name="R"><text:list-level-style-number text:level="1" style:num-format="I" style:num-prefix="(" style:num-suffix=")"/></text:list-style>';
    const doc = await extract(
      odp(
        page(
          frame(
            '<text:list text:style-name="B"><text:list-item><text:p>Point</text:p><text:list><text:list-item><text:p>Detail</text:p></text:list-item></text:list></text:list-item></text:list>' +
              p('Plain between') +
              '<text:list text:style-name="N"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p><text:list><text:list-item><text:p>Sub</text:p></text:list-item></text:list></text:list-item></text:list>' +
              '<text:list text:style-name="N"><text:list-item><text:p>Three</text:p></text:list-item></text:list>' +
              p('') +
              p('Restart') +
              '<text:list text:style-name="R"><text:list-item><text:p>Roman</text:p></text:list-item></text:list>' +
              '<text:list><text:list-item><text:p>Unstyled</text:p></text:list-item></text:list>',
            '1cm',
            '1cm',
          ),
        ),
        { sharedStyles: listStyles },
      ),
    );
    expect(slides(doc)[0]).toMatchObject([
      {
        kind: 'list',
        ordered: false,
        items: [{ text: 'Point', marker: '➢', items: [{ text: 'Detail', marker: '•' }] }],
      },
      { kind: 'paragraph', text: 'Plain between' },
      {
        kind: 'list',
        ordered: true,
        items: [
          { text: 'One', marker: '1.' },
          { text: 'Two', marker: '2.', items: [{ text: 'Sub', marker: 'c)' }] },
          { text: 'Three', marker: '3.' },
        ],
      },
      // An empty paragraph is skipped; a paragraph with text ends the list and restarts numbering.
      { kind: 'paragraph', text: 'Restart' },
      {
        kind: 'list',
        ordered: true,
        items: [
          { text: 'Roman', marker: '(I)' },
          { text: 'Unstyled', marker: '•' },
        ],
      },
    ]);
  });

  it('reads tables with header rows, spans, covered cells and capped repeats', async () => {
    const cell = (text: string, attrs = '') => `<table:table-cell ${attrs}>${p(text)}</table:table-cell>`;
    const doc = await extract(
      odp(
        page(
          `<draw:frame svg:x="1cm" svg:y="1cm"><table:table table:use-first-row-styles="true">` +
            `<table:table-header-rows><table:table-row>${cell('Site')}${cell('Reading', 'table:number-columns-spanned="2"')}<table:covered-table-cell>${p('ignored')}</table:covered-table-cell></table:table-row></table:table-header-rows>` +
            `<table:table-row>${cell('North', 'table:number-rows-spanned="2"')}${cell('7', 'table:number-columns-repeated="2"')}</table:table-row>` +
            `<table:table-row><table:covered-table-cell/>${cell('x', 'table:number-columns-repeated="99999"')}</table:table-row>` +
            `</table:table></draw:frame>`,
        ),
      ),
    );
    const table = slides(doc)[0]![0]!;
    expect(table.kind).toBe('table');
    if (table.kind !== 'table') return;
    expect(table.headerRows).toBe(1);
    expect(table.rows.slice(0, 2)).toEqual([
      [{ text: 'Site' }, { text: 'Reading', colSpan: 2 }, { text: '' }],
      [{ text: 'North', rowSpan: 2 }, { text: '7' }, { text: '7' }],
    ]);
    expect(table.rows[2]).toHaveLength(1 + 75);
  });

  it('keeps speaker notes, skips generated placeholders and the notes slide image', async () => {
    const doc = await extract(
      odp(
        page(
          frame(p('Visible'), '1cm', '1cm') +
            frame(p('12'), '1cm', '18cm', 'presentation:class="page-number"') +
            frame(p('2026-01-01'), '1cm', '18cm', 'presentation:class="date-time"') +
            frame(p('Survey team'), '5cm', '18cm', 'presentation:class="footer"') +
            '<presentation:notes><draw:page-thumbnail presentation:class="page"/>' +
            frame(p('First note') + p('Second note'), '1cm', '10cm', 'presentation:class="notes"') +
            frame(p('3'), '1cm', '20cm', 'presentation:class="page-number"') +
            frame(p('Loose note box'), '1cm', '12cm') +
            '</presentation:notes>',
        ),
      ),
    );
    expect(slides(doc)[0]).toMatchObject([
      { kind: 'paragraph', text: 'Visible' },
      { kind: 'footer', text: 'Survey team' },
      { kind: 'note', role: 'speaker-notes', text: 'First note\nSecond note\nLoose note box' },
    ]);
  });

  it('marks slides hidden by their drawing-page style and warns once', async () => {
    const doc = await extract(
      odp(
        page(frame(p('a'), '1cm', '1cm'), 'draw:style-name="dp1"') +
          page(frame(p('b'), '1cm', '1cm'), 'draw:style-name="dp2"'),
        {
          styles:
            '<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="visible"/></style:style>' +
            '<style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>',
        },
      ),
    );
    expect(doc.blocks.map((block) => (block.kind === 'section' ? block.hidden : null))).toEqual([
      undefined,
      true,
    ]);
    expect(doc.warnings).toEqual([
      { code: 'HIDDEN_CONTENT', message: '1 hidden slides are included with hidden: true.' },
    ]);
  });

  it('builds text from spans, spaces, tabs and breaks without annotations', async () => {
    const doc = await extract(
      odp(
        page(
          frame(
            `<text:p>a<text:s text:c="2"/>b<text:tab/>c<text:line-break/><text:span>d</text:span><office:annotation><text:p>comment</text:p></office:annotation> <text:a xlink:href="https://example.org">link</text:a></text:p>`,
            '1cm',
            '1cm',
          ),
        ),
      ),
    );
    expect(slides(doc)[0]).toMatchObject([{ kind: 'paragraph', text: 'a  b\tc\nd link' }]);
    expect(doc.features.hasExternalLinks).toBe(true);
  });

  it('flags macros and embedded objects, reads metadata and refuses encrypted packages', async () => {
    const meta =
      `<office:document-meta xmlns:office="${NS.office}" xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      '<office:meta><dc:title>Deck</dc:title></office:meta></office:document-meta>';
    const doc = await extract(
      odp(page(`<draw:frame svg:x="1cm" svg:y="1cm"><draw:object xlink:href="./Object 1"/></draw:frame>`), {
        extra: [
          { name: 'meta.xml', data: encode(meta) },
          { name: 'Scripts/python/a.py', data: encode('x') },
        ],
      }),
    );
    expect(doc.metadata.title).toBe('Deck');
    expect(doc.features).toMatchObject({ hasMacros: true, hasEmbeddedFiles: true, hasExternalLinks: false });
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['MACROS_PRESENT']);

    const manifest =
      `<manifest:manifest xmlns:manifest="${NS.manifest}"><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml">` +
      '<manifest:encryption-data/></manifest:file-entry></manifest:manifest>';
    await expect(
      extract(odp(page(''), { extra: [{ name: 'META-INF/manifest.xml', data: encode(manifest) }] })),
    ).rejects.toBeInstanceOf(EncryptedError);
  });

  it('warns about a missing content part and duplicate part names', async () => {
    const missing = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.presentation'), method: 0 },
      ]),
    );
    expect(missing.blocks).toEqual([]);
    expect(missing.warnings.map((warning) => warning.message)).toEqual([
      'The ODP package has no content part.',
    ]);
    const content = (text: string) =>
      encode(
        `<office:document-content ${declarations}><office:body><office:presentation>${page(frame(p(text), '1cm', '1cm'))}</office:presentation></office:body></office:document-content>`,
      );
    const duplicate = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.presentation'), method: 0 },
        { name: 'content.xml', data: content('a') },
        { name: 'content.xml', data: content('b') },
      ]),
    );
    expect(duplicate.blocks).toEqual([]);
    expect(duplicate.warnings[0]!.message).toBe(
      'The ODP package has duplicate part names; that part was not read.',
    );
  });

  it('resolves names by namespace, not by prefix', async () => {
    const content =
      `<o:document-content xmlns:o="${NS.office}" xmlns:d="${NS.draw}" xmlns:s="${NS.svg}" xmlns:t="${NS.text}" xmlns:pr="${NS.presentation}">` +
      `<o:body><o:presentation><d:page><d:frame s:x="1cm" s:y="1cm" pr:class="title"><d:text-box><t:p>Prefixed</t:p></d:text-box></d:frame></d:page></o:presentation></o:body></o:document-content>`;
    const doc = await extract(
      makeZip([
        { name: 'mimetype', data: encode('application/vnd.oasis.opendocument.presentation'), method: 0 },
        { name: 'content.xml', data: encode(content) },
      ]),
    );
    expect(doc.blocks[0]).toMatchObject({ title: 'Prefixed' });
  });

  it('converts ODF lengths to millimetres', () => {
    expect(lengthInMillimetres('2.54cm')).toBeCloseTo(25.4);
    expect(lengthInMillimetres('1in')).toBeCloseTo(25.4);
    expect(lengthInMillimetres('72pt')).toBeCloseTo(25.4);
    expect(lengthInMillimetres('6pc')).toBeCloseTo(25.4);
    expect(lengthInMillimetres('96px')).toBeCloseTo(25.4);
    expect(lengthInMillimetres('-3mm')).toBe(-3);
    for (const bad of [undefined, '', 'cm', '1em', '1.2.3cm', 'x'.repeat(40)])
      expect(lengthInMillimetres(bad)).toBeUndefined();
  });

  it('survives the fuzz target on packages and raw content', async () => {
    await expect(fuzzOdp(odp(page(frame(p('a'), '1cm', '1cm'))))).resolves.toBeUndefined();
    await expect(
      fuzzOdp(
        encode(
          `<office:document-content ${declarations}><office:body><office:presentation/></office:body></office:document-content>`,
        ),
      ),
    ).resolves.toBeUndefined();
    await expect(fuzzOdp(encode('<broken'))).resolves.toBeUndefined();
  });
});

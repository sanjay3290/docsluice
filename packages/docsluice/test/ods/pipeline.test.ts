import { describe, expect, it, vi } from 'vitest';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader } from '../../src/core/reader.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { toJSON } from '../../src/render/json.js';
import { toText } from '../../src/render/text.js';
import { reader } from '../../src/readers/ods/index.js';
import { makeZip } from '../helpers/zip.js';

const office = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const table = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const text = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const dc = 'http://purl.org/dc/elements/1.1/';
const meta = 'urn:oasis:names:tc:opendocument:xmlns:meta:1.0';
const odsMime = 'application/vnd.oasis.opendocument.spreadsheet';

function odsZip(
  content: string,
  metadata?: string,
  extras: Array<{ name: string; data: string }> = [],
): Uint8Array {
  const entries = [
    { name: 'mimetype', data: new TextEncoder().encode(odsMime) },
    { name: 'content.xml', data: new TextEncoder().encode(content) },
    ...(metadata ? [{ name: 'meta.xml', data: new TextEncoder().encode(metadata) }] : []),
    ...extras.map((entry) => ({ name: entry.name, data: new TextEncoder().encode(entry.data) })),
  ];
  return makeZip(entries);
}

function content(body: string): string {
  return `<office:document-content xmlns:office="${office}" xmlns:table="${table}" xmlns:text="${text}"><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>`;
}

function odsRegistry(): ReaderRegistry {
  const registry = new ReaderRegistry();
  registry.add({ id: 'ods', mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
  return registry;
}

describe('ODS extraction pipeline', () => {
  it('keeps the populated cell after a sparse merged span in Markdown and JSON', async () => {
    const bytes = odsZip(
      content(
        '<table:table table:name="Merged"><table:table-row><table:table-cell office:value-type="string" table:number-columns-spanned="2"><text:p>Anchor</text:p></table:table-cell><table:covered-table-cell/><table:table-cell office:value-type="string"><text:p>Next</text:p></table:table-cell></table:table-row></table:table>',
      ),
    );
    const doc = await createExtractor(odsRegistry())(bytes);
    expect(toText(doc)).toContain('Anchor\tNext');
    expect(toMarkdown(doc)).toContain('Next');
    expect((JSON.parse(toJSON(doc)) as typeof doc).blocks).toEqual(doc.blocks);
  });

  it('preserves sheet visibility and includes hidden sheets by default', async () => {
    const doc = await createExtractor(odsRegistry())(
      odsZip(
        content(
          '<table:table table:name="Visible"/><table:table table:name="Hidden" table:display="false"/>',
        ),
      ),
    );
    const [visible, hidden] = doc.blocks;
    expect(visible).toMatchObject({ kind: 'section', title: 'Visible' });
    expect(visible?.kind === 'section' ? visible.hidden : undefined).toBe(false);
    expect(hidden).toMatchObject({ kind: 'section', title: 'Hidden', hidden: true });
    expect((JSON.parse(toJSON(doc)) as typeof doc).blocks).toEqual(doc.blocks);

    const includedExplicitly = await createExtractor(odsRegistry())(
      odsZip(content('<table:table table:name="Hidden" table:display="false"/>')),
      { includeHidden: true },
    );
    expect(includedExplicitly.blocks).toMatchObject([{ kind: 'section', title: 'Hidden', hidden: true }]);
  });
  it('detects a real mimetype-first ODS ZIP and extracts sparse, merged, formula and private metadata', async () => {
    const metadata = `<office:document-meta xmlns:office="${office}" xmlns:dc="${dc}" xmlns:meta="${meta}"><office:meta><dc:title>Quarterly ledger</dc:title><dc:creator>Private Author</dc:creator><meta:user-defined meta:name="department">Finance</meta:user-defined></office:meta></office:document-meta>`;
    const bytes = odsZip(
      content(
        `<table:table table:name="Ledger"><table:table-row table:number-rows-repeated="1048576"><table:table-cell/></table:table-row><table:table-row><table:table-cell office:value-type="string"><text:p>Tail</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="4" table:formula="of:=2+2"><text:p>4</text:p></table:table-cell></table:table-row></table:table><table:table table:name="Merged"><table:table-row><table:table-cell office:value-type="string" table:number-columns-spanned="2"><text:p>Anchor</text:p></table:table-cell><table:covered-table-cell/><table:table-cell office:value-type="string"><text:p>Next</text:p></table:table-cell></table:table-row></table:table>`,
      ),
      metadata,
    );
    const doc = await createExtractor(odsRegistry())(bytes, { formulas: true, metadata: false });

    expect(doc).toMatchObject({ format: 'ods', mimeType: odsMime, metadata: { title: 'Quarterly ledger' } });
    expect(doc.metadata.authors).toBeUndefined();
    expect(doc.metadata.custom).toBeUndefined();
    const [ledger, merged] = doc.blocks;
    expect(ledger).toMatchObject({ kind: 'section', role: 'sheet', title: 'Ledger' });
    expect(merged).toMatchObject({ kind: 'section', role: 'sheet', title: 'Merged' });
    if (ledger?.kind !== 'section' || merged?.kind !== 'section') throw new Error('expected sheet sections');
    expect(ledger.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: 'Tail', address: 'Ledger!A1048577' },
          { text: '4', raw: 4, formula: 'of:=2+2', address: 'Ledger!B1048577' },
        ],
      ],
    });
    expect(merged.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [
          { text: 'Anchor', colSpan: 2, address: 'Merged!A1' },
          { text: 'Next', address: 'Merged!C1' },
        ],
      ],
    });
    expect(doc.stats.truncated).toBe(false);
    expect(toText(doc)).toContain('Tail\t4');
    expect(toText(doc)).toContain('Anchor\tNext');
    expect(toMarkdown(doc)).toContain('| Anchor |');
  });

  it('shares the output budget through extraction and retains only the accepted partial table', async () => {
    const bytes = odsZip(
      content(
        `<table:table table:name="S"><table:table-row><table:table-cell table:number-columns-repeated="10000" office:value-type="string"><text:p>x</text:p></table:table-cell></table:table-row></table:table>`,
      ),
    );
    const doc = await createExtractor(odsRegistry())(bytes, { limits: { outputChars: 8 } });
    const sheet = doc.blocks[0];
    if (sheet?.kind !== 'section' || sheet.blocks[0]?.kind !== 'table')
      throw new Error('expected partial table');
    expect(sheet.blocks[0].rows[0]).toHaveLength(7);
    expect(doc.stats.truncated).toBe(true);
    expect(toText(doc)).toContain('x\tx\tx');
  });

  it('uses the child document path and leaves external links unread and unfetched', async () => {
    const hrefs = `<table:table table:name="Links"><table:table-row><table:table-cell office:value-type="string"><text:p><text:a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="https://example.invalid/data.ods">external data</text:a></text:p></table:table-cell></table:table-row></table:table>`;
    const nested = odsZip(content(hrefs));
    const registry = odsRegistry();
    const parent: Reader = {
      id: 'fake',
      mimeTypes: ['application/x-fake'],
      async read(ctx) {
        await ctx.extractChild('nested.ods', nested);
      },
    };
    registry.add({ id: 'fake', mimeTypes: parent.mimeTypes, load: () => Promise.resolve(parent) });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    try {
      const doc = await createExtractor(registry)(new TextEncoder().encode('parent'), { format: 'fake' });
      const child = doc.children[0]?.document;
      expect(child?.format).toBe('ods');
      expect(child?.features.hasExternalLinks).toBe(true);
      expect(child?.blocks[0]?.loc.path).toBe('nested.ods/content.xml');
      expect(toText(child!)).toContain('external data');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extract } from '../../src/core/extract.js';
import { toJSON } from '../../src/render/json.js';
import { toMarkdown } from '../../src/render/markdown.js';
import { toText } from '../../src/render/text.js';
import { makeZip } from '../helpers/zip.js';

const update =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN ===
  '1';
const corpus = new URL('../../../../corpus/docx/', import.meta.url);
const fixture = () => new Uint8Array(readFileSync(new URL('revisions-images.docx', corpus)));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const encode = (value: string) => new TextEncoder().encode(value);

function docx(body: string): Uint8Array {
  return makeZip([
    {
      name: '[Content_Types].xml',
      data: encode(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
    },
    {
      name: 'word/document.xml',
      data: encode(`<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`),
    },
  ]);
}

describe('DOCX tracked changes (DOC-6)', () => {
  afterEach(() => vi.unstubAllGlobals());

  // accept is the default and is covered by the golden runner; the other modes use sidecar goldens.
  it.each(['reject', 'show'] as const)(
    'matches the reviewed %s-mode output of the corpus file',
    async (revisions) => {
      const doc = await extract(fixture(), { filename: 'revisions-images.docx', revisions });
      doc.stats.durationMs = 0;
      const json = toJSON(doc, { stable: true });
      const markdown = toMarkdown(doc);
      const jsonPath = new URL(`revisions-images.docx.${revisions}.expected.json`, corpus);
      const markdownPath = new URL(`revisions-images.docx.${revisions}.expected.md`, corpus);
      if (update) {
        writeFileSync(jsonPath, json);
        writeFileSync(markdownPath, markdown);
        return;
      }
      expect(existsSync(jsonPath)).toBe(true);
      expect(json).toBe(readFileSync(jsonPath, 'utf8'));
      expect(markdown).toBe(readFileSync(markdownPath, 'utf8'));
    },
  );

  it('reports HIDDEN_CONTENT only when the document has tracked changes', async () => {
    expect((await extract(docx('<w:p><w:r><w:t>plain</w:t></w:r></w:p>'))).warnings).toEqual([]);
    const tracked = await extract(
      docx(
        '<w:p><w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del><w:r><w:t>kept</w:t></w:r></w:p>',
      ),
    );
    expect(tracked.warnings.map(({ code }) => code)).toEqual(['HIDDEN_CONTENT']);
    expect(toText(tracked)).toBe('kept');
  });

  it('keeps a final paragraph whose removed mark has nothing to join, and writes no markers for empty revisions', async () => {
    const body = '<w:p><w:pPr><w:rPr><w:del w:id="1"/></w:rPr></w:pPr><w:r><w:t>last</w:t></w:r></w:p>';
    expect(toText(await extract(docx(body)))).toBe('last');
    const empty = '<w:p><w:r><w:t>a</w:t></w:r><w:ins w:id="2"/><w:r><w:t>b</w:t></w:r></w:p>';
    expect(toText(await extract(docx(empty), { revisions: 'show' }))).toBe('ab');
  });

  it('drops a picture inside deleted content when changes are accepted', async () => {
    const body = `<w:p><w:del w:id="1"><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:docPr id="1" name="x" descr="Removed figure"/></wp:inline></w:drawing></w:r></w:del><w:r><w:t>text</w:t></w:r></w:p>`;
    expect((await extract(docx(body))).blocks.map((block) => block.kind)).toEqual(['paragraph']);
    expect((await extract(docx(body), { revisions: 'reject' })).blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'image',
    ]);
  });
});

describe('DOCX images (DOC-8)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('emits alt text, pixel size, MIME type and a ref to a listed child; external pictures are never fetched', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const doc = await extract(fixture(), { filename: 'revisions-images.docx' });
    expect(doc.blocks.filter((block) => block.kind === 'image')).toMatchObject([
      { alt: 'Marsh map', width: 200, height: 100, mimeType: 'image/png', ref: 'word/media/image1.png' },
      { alt: 'Legacy figure', width: 128, height: 64, mimeType: 'image/png', ref: 'word/media/image2.png' },
      { alt: 'Remote picture', width: 100, height: 100 },
    ]);
    expect(
      doc.blocks.find((block) => block.kind === 'image' && block.alt === 'Remote picture'),
    ).not.toHaveProperty('ref');
    expect(doc.children).toEqual([
      {
        path: 'word/media/image1.png',
        name: 'word/media/image1.png',
        status: 'listed',
        sizeBytes: 70,
        mimeType: 'image/png',
      },
      {
        path: 'word/media/image2.png',
        name: 'word/media/image2.png',
        status: 'listed',
        sizeBytes: 70,
        mimeType: 'image/png',
      },
    ]);
    expect(doc.features.hasExternalLinks).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('attaches bytes with childBytes and omits refs and children with children: skip', async () => {
    const withBytes = await extract(fixture(), { childBytes: true });
    expect(withBytes.children.map((child) => child.bytes?.length)).toEqual([70, 70]);
    expect(Array.from(withBytes.children[0]!.bytes!.subarray(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const skipped = await extract(fixture(), { children: 'skip' });
    expect(skipped.children).toEqual([]);
    expect(skipped.blocks.some((block) => block.kind === 'image' && block.ref !== undefined)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { EncryptedError, LimitExceededError } from '../../../src/core/errors.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { makeZip } from '../../helpers/zip.js';
import { fuzzEpub } from '../../../fuzz/epub.fuzz.js';
import reader from '../../../src/readers/epub/index.js';

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

async function parse(
  bytes: Uint8Array,
  options: { metadata?: boolean; includeHidden?: boolean } = {},
  limits: Record<string, number> = {},
  onLimit: 'truncate' | 'throw' = 'truncate',
  signal?: AbortSignal,
) {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings, onLimit, signal });
  const resolved = {
    limits: budget.limits,
    metadata: options.metadata ?? true,
    includeHidden: options.includeHidden ?? false,
  } as ResolvedOptions;
  const out = new DocBuilder('epub', 'application/epub+zip', budget, resolved);
  const ctx = {
    bytes,
    options: resolved,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

function miniatureEpub(encryption = false): Uint8Array {
  const files: Array<{ name: string; data: Uint8Array; method?: number }> = [
    { name: 'mimetype', data: enc('application/epub+zip') },
    {
      name: 'META-INF/container.xml',
      data: enc('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
    },
    {
      name: 'OPS/book.opf',
      data: enc(
        '<package><metadata><dc:title xmlns:dc="x">Safe Book</dc:title></metadata><manifest><item id="ch" href="Text/ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>',
      ),
    },
    { name: 'OPS/Text/ch.xhtml', data: enc('<html><body><p>Readable chapter.</p></body></html>') },
  ];
  if (encryption)
    files.push({
      name: 'META-INF/encryption.xml',
      data: enc(
        '<encryption><EncryptedData><CipherData><CipherReference URI="OPS/Text/ch.xhtml"/></CipherData></EncryptedData></encryption>',
      ),
    });
  return makeZip(files);
}

describe('EPUB reader', () => {
  it('closes the chapter section after a throwing parser limit', async () => {
    const bytes = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="book.opf"/></container>'),
      },
      {
        name: 'book.opf',
        data: enc(
          '<package><manifest><item id="ch" href="ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>',
        ),
      },
      { name: 'ch.xhtml', data: enc('<div><div><p>secret</p></div></div>') },
    ]);
    const budget = new Budget(resolveLimits({ blockDepth: 2 }), { onLimit: 'throw' });
    const out = new DocBuilder('epub', 'application/epub+zip', budget);
    await expect(
      reader.read({
        bytes,
        options: { limits: budget.limits } as ResolvedOptions,
        budget,
        warnings: budget.warnings,
        out,
        path: '',
        extractChild: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    expect(budget.enterDepth('block')).toBe(true);
    expect(budget.enterDepth('block')).toBe(true);
    budget.exitDepth('block');
    budget.exitDepth('block');
  });
  it('resolves navigation targets relative to the navigation file and honors empty output allowance', async () => {
    const files = [
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="OPS/book.opf"/></container>'),
      },
      {
        name: 'OPS/book.opf',
        data: enc(
          '<package><manifest><item id="nav" href="Nav/nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ch" href="Text/ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>',
        ),
      },
      {
        name: 'OPS/Nav/nav.xhtml',
        data: enc('<html><body><nav><a href="../Text/ch.xhtml">Chapter One</a></nav></body></html>'),
      },
      { name: 'OPS/Text/ch.xhtml', data: enc('<p>Body</p>') },
    ];
    expect((await parse(makeZip(files))).doc.blocks).toMatchObject([
      { kind: 'section', title: 'Chapter One', blocks: [{ text: 'Body' }] },
    ]);
    expect((await parse(makeZip(files), {}, { outputChars: 0 })).doc).toMatchObject({
      blocks: [],
      stats: { truncated: true },
    });
    expect((await parse(makeZip(files), {}, { totalUncompressedBytes: 1 })).doc.stats.truncated).toBe(true);
  });
  it('reads EPUB 2 and EPUB 3 chapters in spine order and extracts OPF metadata', async () => {
    const epub2 = await parse(
      new Uint8Array(readFileSync(new URL('../../../../../corpus/epub/tiny-epub2.epub', import.meta.url))),
    );
    expect(epub2.doc.metadata).toMatchObject({
      title: 'Field Guide to Small Birds',
      authors: ['A. Example'],
      language: 'en',
    });
    expect(epub2.doc.blocks.map((block) => block.kind)).toEqual(['section', 'section']);
    expect(epub2.doc.blocks).toMatchObject([
      {
        kind: 'section',
        role: 'part',
        title: 'At Dawn',
        blocks: [
          { kind: 'heading', text: 'At Dawn' },
          { kind: 'paragraph', text: 'A robin sings from the garden wall.' },
        ],
      },
      {
        kind: 'section',
        role: 'part',
        title: 'At Dusk',
        blocks: [
          { kind: 'heading', text: 'At Dusk' },
          { kind: 'paragraph', text: 'Small birds return to the hedgerows.' },
        ],
      },
    ]);

    const epub3 = await parse(
      new Uint8Array(readFileSync(new URL('../../../../../corpus/epub/tiny-epub3.epub', import.meta.url))),
    );
    expect(epub3.doc.metadata).toMatchObject({
      title: 'The Little Observatory',
      authors: ['R. Example'],
      language: 'en',
      modified: '2026-01-01T00:00:00.000Z',
    });
    expect(epub3.doc.blocks).toMatchObject([
      {
        kind: 'section',
        title: 'Morning',
        blocks: [
          { kind: 'heading', text: 'Morning' },
          { kind: 'paragraph', text: 'The first light reached the observatory.' },
        ],
      },
      {
        kind: 'section',
        title: 'Night',
        blocks: [
          { kind: 'heading', text: 'Night' },
          { kind: 'paragraph', text: 'Stars appeared above the quiet hill.' },
        ],
      },
    ]);
    expect(JSON.stringify(epub3.doc)).not.toContain('navigation only');
  });

  it('drops personal creator metadata when metadata is disabled', async () => {
    const { doc } = await parse(
      new Uint8Array(readFileSync(new URL('../../../../../corpus/epub/tiny-epub2.epub', import.meta.url))),
      { metadata: false },
    );
    expect(doc.metadata.authors).toBeUndefined();
    expect(doc.metadata.title).toBe('Field Guide to Small Birds');
  });

  it('skips linear=no spine entries by default and includes them when requested', async () => {
    const files = [
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>'),
      },
      {
        name: 'book.opf',
        data: enc(
          '<package><metadata/><manifest><item id="main" href="main.xhtml" media-type="application/xhtml+xml"/><item id="extra" href="extra.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="main"/><itemref idref="extra" linear="no"/></spine></package>',
        ),
      },
      { name: 'main.xhtml', data: enc('<p>Main chapter.</p>') },
      { name: 'extra.xhtml', data: enc('<p>Supplementary chapter.</p>') },
    ];
    const archive = makeZip(files);
    const defaultResult = await parse(archive);
    expect(JSON.stringify(defaultResult.doc)).toContain('Main chapter.');
    expect(JSON.stringify(defaultResult.doc)).not.toContain('Supplementary chapter.');
    const included = await parse(archive, { includeHidden: true });
    expect(JSON.stringify(included.doc)).toContain('Supplementary chapter.');
  });

  it('treats encrypted package parts as unreadable and throws for encrypted package control data', async () => {
    const { doc, warnings } = await parse(miniatureEpub(true));
    expect(doc.features.isEncrypted).toBe(true);
    expect(doc.blocks).toEqual([]);
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
    await expect(
      parse(makeZip([{ name: 'META-INF/container.xml', data: enc('<container/>'), flags: 0x0801 }])),
    ).rejects.toBeInstanceOf(EncryptedError);
  });

  it('uses nested NCX labels for chapter titles and resolves NCX paths relative to the NCX file', async () => {
    const bytes = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="OPS/book.opf"/></container>'),
      },
      {
        name: 'OPS/book.opf',
        data: enc(
          '<package><manifest><item id="toc" href="Nav/toc.ncx" media-type="application/x-dtbncx+xml"/><item id="chapter" href="Text/ch.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        ),
      },
      {
        name: 'OPS/Nav/toc.ncx',
        data: enc(
          '<ncx><navMap><navPoint><navLabel><span><text>Nested chapter title</text></span></navLabel><content src="../Text/ch.xhtml"/></navPoint></navMap></ncx>',
        ),
      },
      { name: 'OPS/Text/ch.xhtml', data: enc('<p>NCX chapter body.</p>') },
    ]);
    const { doc } = await parse(bytes);
    expect(doc.blocks).toMatchObject([
      {
        kind: 'section',
        title: 'Nested chapter title',
        blocks: [{ kind: 'paragraph', text: 'NCX chapter body.' }],
      },
    ]);
  });

  it('rejects absent container/package files and reports malformed or incomplete OPF manifests', async () => {
    const noContainer = makeZip([{ name: 'book.opf', data: enc('<package/>') }]);
    await expect(parse(noContainer)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });

    const noRootfile = makeZip([{ name: 'META-INF/container.xml', data: enc('<container/>') }]);
    await expect(parse(noRootfile)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });

    const missingPackage = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="missing.opf"/></container>'),
      },
    ]);
    await expect(parse(missingPackage)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });

    const emptyPackage = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="book.opf"/></container>'),
      },
      { name: 'book.opf', data: new Uint8Array() },
    ]);
    await expect(parse(emptyPackage)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });

    const missingSpine = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="book.opf"/></container>'),
      },
      { name: 'book.opf', data: enc('<package><metadata/></package>') },
    ]);
    const result = await parse(missingSpine);
    expect(result.doc.blocks).toEqual([]);
    expect(result.warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('does not follow malformed or missing manifest references and reports unreadable chapter data', async () => {
    const bytes = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfile full-path="OPS/book.opf"/></container>'),
      },
      {
        name: 'OPS/book.opf',
        data: enc(
          '<package><manifest><item id="bad" href="%ZZ.xhtml" media-type="application/xhtml+xml"/><item id="absent" href="Text/absent.xhtml" media-type="application/xhtml+xml"/><item id="broken" href="Text/broken.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="bad"/><itemref idref="absent"/><itemref idref="broken"/><itemref idref="unknown"/></spine></package>',
        ),
      },
      { name: 'OPS/Text/broken.xhtml', data: enc('<p>UNREADABLE CHAPTER</p>'), method: 12 },
    ]);
    const { doc, warnings } = await parse(bytes);
    expect(JSON.stringify(doc)).not.toContain('UNREADABLE CHAPTER');
    expect(doc.blocks).toEqual([]);
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('rejects traversal references without reading a similarly named archive entry', async () => {
    const bytes = makeZip([
      {
        name: 'META-INF/container.xml',
        data: enc('<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>'),
      },
      {
        name: 'OPS/book.opf',
        data: enc(
          '<package><metadata/><manifest><item id="ch" href="../../outside.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="ch"/></spine></package>',
        ),
      },
      { name: 'outside.xhtml', data: enc('<p>SHOULD_NOT_ESCAPE</p>') },
    ]);
    const { doc, warnings } = await parse(bytes);
    expect(JSON.stringify(doc)).not.toContain('SHOULD_NOT_ESCAPE');
    expect(warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('honors output limits, onLimit throw, abort, and malformed container data', async () => {
    const bytes = miniatureEpub();
    const truncated = await parse(bytes, {}, { outputChars: 10 });
    expect(truncated.doc.stats.truncated).toBe(true);
    expect(truncated.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    const entryLimited = await parse(bytes, {}, { zipEntries: 1 });
    expect(entryLimited.doc.stats.truncated).toBe(true);
    expect(entryLimited.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    await expect(parse(bytes, {}, { outputChars: 10 }, 'throw')).rejects.toBeInstanceOf(LimitExceededError);
    await expect(parse(bytes, {}, { zipEntries: 1 }, 'throw')).rejects.toBeInstanceOf(LimitExceededError);
    const controller = new AbortController();
    controller.abort();
    await expect(parse(bytes, {}, {}, 'truncate', controller.signal)).rejects.toMatchObject({
      code: 'ABORTED',
    });
    await expect(parse(enc('not a zip'))).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
  });

  it('runs the bounded EPUB fuzz harness on arbitrary and malformed bytes', async () => {
    await fuzzEpub(new Uint8Array([0, 80, 75, 3, 4, 255]));
    await fuzzEpub(enc('PK\u0003\u0004 <container><rootfile full-path="../../bad.opf"/></container>'));
  });
});

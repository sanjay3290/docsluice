import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createExtractor, extract, resolveOptions } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader, ReadContext } from '../../src/core/reader.js';
import { CorruptFileError } from '../../src/core/errors.js';
import { toText } from '../../src/render/text.js';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { openCfb } from '../../src/ole/index.js';
import { openZip } from '../../src/zip/index.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function registry(read: (ctx: ReadContext) => Promise<void> | void = () => {}): {
  registry: ReaderRegistry;
  load: ReturnType<typeof vi.fn>;
} {
  const registry = new ReaderRegistry();
  const reader: Reader = {
    id: 'fake',
    mimeTypes: ['application/x-fake'],
    async read(ctx) {
      await read(ctx);
    },
  };
  const load = vi.fn(() => Promise.resolve(reader));
  registry.add({ id: 'fake', mimeTypes: reader.mimeTypes, load });
  return { registry, load };
}

function addTextReader(registry: ReaderRegistry, read: (ctx: ReadContext) => void | Promise<void>): void {
  registry.add({
    id: 'txt',
    mimeTypes: ['text/plain'],
    load: () =>
      Promise.resolve({
        id: 'txt',
        mimeTypes: ['text/plain'],
        async read(ctx: ReadContext) {
          await read(ctx);
        },
      }),
  });
}

afterEach(() => vi.useRealTimers());

describe('extraction pipeline', () => {
  it('retains mixed skipped and extracted child order when readers await child work', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('first.txt', bytes('first'));
      ctx.out.addChild({ path: 'directory/', name: 'directory/', status: 'skipped', sizeBytes: 0 });
      await ctx.extractChild('last.txt', bytes('last'));
    });
    addTextReader(readers, (ctx) => {
      ctx.out.paragraph(new TextDecoder().decode(ctx.bytes));
    });
    const doc = await createExtractor(readers)(bytes('container'), { format: 'fake' });
    expect(doc.children.map((child) => [child.path, child.status])).toEqual([
      ['first.txt', 'extracted'],
      ['directory/', 'skipped'],
      ['last.txt', 'extracted'],
    ]);
  });

  it('keeps warnings isolated between concurrent siblings and forwards them to the parent', async () => {
    let releaseFirst!: () => void;
    const secondWarning = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { registry: readers } = registry(async (ctx) => {
      await Promise.all([
        ctx.extractChild('a.txt', bytes('first child')),
        ctx.extractChild('b.txt', bytes('second child')),
      ]);
    });
    addTextReader(readers, async (ctx) => {
      const first = ctx.path === 'a.txt';
      ctx.warnings.add({
        code: 'HIDDEN_CONTENT',
        message: first ? 'First child warning.' : 'Second child warning.',
        loc: { path: 'part' },
      });
      if (first) await secondWarning;
      else releaseFirst();
      ctx.out.paragraph(ctx.path);
    });
    const doc = await createExtractor(readers)(bytes('root'), { format: 'fake' });
    const firstWarning = {
      code: 'HIDDEN_CONTENT',
      message: 'First child warning.',
      loc: { path: 'a.txt/part' },
    };
    const secondWarningValue = {
      code: 'HIDDEN_CONTENT',
      message: 'Second child warning.',
      loc: { path: 'b.txt/part' },
    };
    expect(doc.children[0]!.document!.warnings).toEqual([firstWarning]);
    expect(doc.children[1]!.document!.warnings).toEqual([secondWarningValue]);
    expect(doc.warnings).toEqual([firstWarning, secondWarningValue]);
  });

  it('cancels pending descendant work when its parent reader fails', async () => {
    let childStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      childStarted = resolve;
    });
    let childContext: ReadContext | undefined;
    const { registry: readers } = registry(async (ctx) => {
      void ctx.extractChild('child.txt', bytes('child'));
      await started;
      throw new Error('Reader failure.');
    });
    addTextReader(readers, async (ctx) => {
      childContext = ctx;
      childStarted();
      await new Promise<void>(() => {});
    });
    await expect(createExtractor(readers)(bytes('root'), { format: 'fake' })).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    expect(childContext!.budget.signal!.aborted).toBe(true);
  });

  it('resolves and snapshots safe defaults once', () => {
    const strict = ['UNREADABLE_PART'];
    const options = resolveOptions({ strict, limits: { outputChars: 7 } });
    strict.push('HIDDEN_CONTENT');
    expect(options).toMatchObject({
      metadata: true,
      children: 'extract',
      childBytes: false,
      runs: false,
      revisions: 'accept',
      includeHidden: false,
      formulas: false,
      onLimit: 'truncate',
      limits: { outputChars: 7, childDepth: 3 },
      strict: ['UNREADABLE_PART'],
    });
    expect(Object.isFrozen(options)).toBe(true);
    expect(Object.isFrozen(options.limits)).toBe(true);
    expect(Object.isFrozen(options.strict)).toBe(true);
  });

  it('loads the selected reader lazily and caches the resolved module', async () => {
    const { registry: readers, load } = registry((ctx) => {
      ctx.out.paragraph('Hello');
      ctx.out.paragraph('World');
    });
    const extract = createExtractor(readers);
    expect(load).not.toHaveBeenCalled();
    const doc = await extract(bytes('fake'), { format: 'fake' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(doc.format).toBe('fake');
    expect(toText(doc)).toBe('Hello\n\nWorld');
    expect(doc.blocks.map((block) => block.loc.offset)).toEqual([
      [0, 5],
      [7, 12],
    ]);
    expect(doc.stats).toMatchObject({ bytesRead: 4, truncated: false, needsOcr: false });
    await extract(bytes('again'), { format: 'fake' });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not import readers while returning empty documents for detected images', async () => {
    const { registry: readers, load } = registry();
    const extract = createExtractor(readers);
    const png = await extract(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = await extract(new Uint8Array([255, 216, 255, 224, 0, 16]));
    expect(png).toMatchObject({ format: 'png', mimeType: 'image/png', blocks: [] });
    expect(jpeg).toMatchObject({ format: 'jpeg', mimeType: 'image/jpeg', blocks: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it('extracts the native DOC through the public pipeline with one CFB index and one cell charge', async () => {
    const fixture = new Uint8Array(
      readFileSync(new URL('../../../../corpus/doc/doc-legacy.doc', import.meta.url)),
    );
    const probe = new Budget(DEFAULT_LIMITS);
    openCfb(fixture, probe);
    const doc = await extract(fixture, {
      filename: 'native.doc',
      limits: { zipEntries: probe.entries, cells: 4 },
    });
    expect(doc.format).toBe('doc');
    expect(doc.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'heading',
      'table',
      'paragraph',
    ]);
    expect(doc.stats).toMatchObject({ bytesRead: fixture.length, truncated: false });
    expect(doc.warnings).toEqual([]);
    expect(toText(doc)).toBe(
      'Legacy Word fixture\n\nParagraph with café, €12, and a visible field result: July 4, 2026.\n\nSecond heading\n\nItem\tCount\nPaper\t3\n\nFinal paragraph for text recall.',
    );
    for (const block of doc.blocks) {
      expect(block.loc.offset).toBeDefined();
      const [start, end] = block.loc.offset!;
      if ('text' in block) expect(toText(doc).slice(start, end)).toBe(block.text);
    }
  });

  it('extracts TXT and Markdown through the public pipeline', async () => {
    const txt = await extract(bytes('first line\nsecond line\n\nnext paragraph'));
    expect(txt).toMatchObject({ format: 'txt', mimeType: 'text/plain', encoding: 'utf-8' });
    expect(txt.blocks.map((block) => block.kind)).toEqual(['paragraph', 'paragraph']);
    const markdown = await extract(bytes('# Title\n\n- one\n- two\n'), { filename: 'notes.md' });
    expect(markdown.format).toBe('markdown');
    expect(markdown.blocks.map((block) => block.kind)).toEqual(['heading', 'list']);
    expect(toText(markdown)).toContain('Title');
  });

  it('extracts JSON leaves and XML element text through the public pipeline', async () => {
    const json = await extract(bytes('{"title":"Report","tags":["a","b"]}'));
    expect(json.format).toBe('json');
    expect(json.blocks.filter((block) => block.kind === 'paragraph').map((block) => block.loc.path)).toEqual([
      '$.title',
      '$.tags[0]',
      '$.tags[1]',
    ]);
    const xml = await extract(bytes('<?xml version="1.0"?><doc><p>one</p><p>two</p></doc>'));
    expect(xml.format).toBe('xml');
    expect(xml.blocks.map((block) => block.loc.path)).toEqual(['/doc/p[1]', '/doc/p[2]']);
  });

  it('reports a guessed TXT or Markdown encoding once, with or without a forced format', async () => {
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    for (const options of [{}, { format: 'txt' as const }, { format: 'markdown' as const }]) {
      const doc = await extract(latin, options);
      expect(doc.encoding).toBe('windows-1252');
      expect(doc.warnings.map(({ code }) => code)).toEqual(['ENCODING_GUESSED']);
    }
  });

  it('passes the already-indexed ZIP to a selected lazy reader without charging entries again', async () => {
    const fixture = new Uint8Array(
      readFileSync(new URL('../../../../corpus/doc/doc-legacy.docx', import.meta.url)),
    );
    const probe = new Budget(DEFAULT_LIMITS);
    openZip(fixture, probe);
    const readers = new ReaderRegistry();
    readers.add({
      id: 'docx',
      mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      load: () =>
        Promise.resolve({
          id: 'docx',
          mimeTypes: [],
          async read(ctx) {
            expect(ctx.zip).toBeDefined();
            const entry = ctx.zip!.entries.find((item) => item.name === 'word/document.xml')!;
            const body = await ctx.zip!.read(entry);
            expect(body?.length).toBeGreaterThan(0);
            expect(ctx.budget.entries).toBe(probe.entries);
            ctx.out.paragraph('indexed once');
          },
        }),
    });
    const doc = await createExtractor(readers)(fixture, { limits: { zipEntries: probe.entries } });
    expect(toText(doc)).toBe('indexed once');
    expect(doc.stats.truncated).toBe(false);
  });

  it('throws an unsupported-format error when the selected format has no reader', async () => {
    await expect(createExtractor(new ReaderRegistry())(bytes('hello'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
      format: 'txt',
    });
  });

  it('applies transformation, metadata privacy and shared output truncation', async () => {
    const { registry: readers } = registry((ctx) => {
      ctx.out.setMetadata({
        title: 'title',
        authors: ['private'],
        custom: [{ name: 'key', value: 'value' }],
      });
      ctx.out.paragraph('discard');
      ctx.out.paragraph('keep');
      ctx.out.paragraph('excess');
    });
    const onBlock = vi.fn();
    const doc = await createExtractor(readers)(bytes('root'), {
      format: 'fake',
      metadata: false,
      limits: { outputChars: 4 },
      onBlock,
      transform: (block) => (block.kind === 'paragraph' && block.text === 'discard' ? null : block),
    });
    expect(doc.metadata).toEqual({ title: 'title' });
    expect(toText(doc)).toBe('keep');
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
    expect(onBlock).toHaveBeenCalledTimes(1);
  });

  it('extracts children using one budget and prefixes semantic locations and warnings', async () => {
    const { registry: readers } = registry(async (ctx) => {
      ctx.out.paragraph('root');
      await ctx.extractChild('folder/a.txt', bytes('child'));
    });
    addTextReader(readers, (ctx) => {
      ctx.out.openSection('part', { path: '/root/element' });
      ctx.out.paragraph('child', { path: '/root/element[2]' });
      ctx.out.closeSection();
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'A part was skipped.', loc: { path: '/part' } });
    });
    const doc = await createExtractor(readers)(bytes('parent'), { format: 'fake', childBytes: true });
    expect(doc.children[0]).toMatchObject({
      path: 'folder/a.txt',
      name: 'folder/a.txt',
      status: 'extracted',
      bytes: bytes('child'),
      document: { stats: { bytesRead: 5 } },
    });
    const child = doc.children[0]!.document!;
    expect(child.blocks[0]!.loc.path).toBe('folder/a.txt/root/element');
    expect(child.blocks[0]!.kind).toBe('section');
    if (child.blocks[0]!.kind === 'section') {
      expect(child.blocks[0]!.blocks[0]!.loc.path).toBe('folder/a.txt/root/element[2]');
    }
    expect(child.warnings.at(-1)!.loc!.path).toBe('folder/a.txt/part');
    expect(doc.stats.bytesRead).toBe(6);
    expect(doc.stats.truncated).toBe(false);
  });

  it('shares the output allowance across siblings without charging child input twice', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('a.txt', bytes('aaa'));
      await ctx.extractChild('b.txt', bytes('bbb'));
    });
    addTextReader(readers, (ctx) => {
      ctx.out.paragraph(new TextDecoder().decode(ctx.bytes));
    });
    const doc = await createExtractor(readers)(bytes('parent'), {
      format: 'fake',
      limits: { inputBytes: 6, outputChars: 3 },
    });
    expect(doc.children.map((child) => child.status)).toEqual(['extracted', 'extracted']);
    expect(doc.children[0]!.document!.blocks).toHaveLength(1);
    expect(doc.children[1]!.document!.blocks).toHaveLength(0);
    expect(doc.stats.truncated).toBe(true);
  });

  it('lists deeper children without loading them, even with onLimit throw', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('a.txt', bytes('branch'));
    });
    const childRead = vi.fn(async (ctx: ReadContext) => {
      ctx.out.paragraph('first');
      await ctx.extractChild('b.txt', bytes('leaf'));
    });
    addTextReader(readers, childRead);
    const doc = await createExtractor(readers)(bytes('root'), {
      format: 'fake',
      limits: { childDepth: 1 },
      onLimit: 'throw',
    });
    expect(childRead).toHaveBeenCalledTimes(1);
    expect(doc.children[0]!.document!.children[0]).toMatchObject({ path: 'a.txt/b.txt', status: 'listed' });
    expect(doc.warnings.map((warning) => warning.code)).toContain('DEPTH_LIMIT');
  });

  it.each(['list', 'skip'] as const)('supports children %s without loading a child reader', async (mode) => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('a.txt', bytes('child'));
    });
    const childRead = vi.fn(() => Promise.resolve());
    addTextReader(readers, childRead);
    const doc = await createExtractor(readers)(bytes('parent'), { format: 'fake', children: mode });
    expect(childRead).not.toHaveBeenCalled();
    expect(doc.children).toHaveLength(mode === 'skip' ? 0 : 1);
    if (mode === 'list') expect(doc.children[0]!.status).toBe('listed');
  });

  it('isolates child failures and never exposes reader error content', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('bad.txt', bytes('bad'));
      ctx.out.paragraph('after');
    });
    addTextReader(readers, () => {
      throw new Error('private document content');
    });
    const doc = await createExtractor(readers)(bytes('parent'), { format: 'fake' });
    expect(toText(doc)).toBe('after');
    expect(doc.children[0]).toMatchObject({ status: 'failed', error: { code: 'CORRUPT_FILE' } });
    expect(doc.children[0]!.error!.message).not.toContain('private');
  });

  it('isolates strict child warnings using structural failure messages', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('bad.txt', bytes('bad'));
    });
    addTextReader(readers, (ctx) => {
      ctx.warnings.add({ code: 'UNREADABLE_PART', message: 'A part was skipped.' });
    });
    const doc = await createExtractor(readers)(bytes('parent'), {
      format: 'fake',
      strict: ['UNREADABLE_PART'],
    });
    expect(doc.children[0]).toMatchObject({ status: 'failed', error: { code: 'STRICT_WARNING' } });
  });

  it('detects an ancestor byte-identical child before importing its reader', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('self.bin', new Uint8Array(ctx.bytes));
    });
    const doc = await createExtractor(readers)(bytes('parent'), { format: 'fake' });
    expect(doc.children[0]).toMatchObject({ status: 'listed' });
    expect(doc.warnings.map((warning) => warning.code)).toContain('DEPTH_LIMIT');
  });

  it('leaves sibling-identical children independent rather than calling them quines', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('a.txt', bytes('leaf'));
      await ctx.extractChild('b.txt', bytes('leaf'));
    });
    addTextReader(readers, (ctx) => {
      ctx.out.paragraph('leaf');
    });
    const doc = await createExtractor(readers)(bytes('root'), { format: 'fake' });
    expect(doc.children.map((child) => child.status)).toEqual(['extracted', 'extracted']);
  });

  it('waits for fire-and-forget child work and preserves request order', async () => {
    const { registry: readers } = registry((ctx) => {
      void ctx.extractChild('a.txt', bytes('first'));
      void ctx.extractChild('b.txt', bytes('second'));
    });
    addTextReader(readers, (ctx) => {
      ctx.out.paragraph(new TextDecoder().decode(ctx.bytes));
    });
    const doc = await createExtractor(readers)(bytes('root'), { format: 'fake' });
    expect(doc.children.map((child) => child.path)).toEqual(['a.txt', 'b.txt']);
    expect(doc.children.map((child) => toText(child.document!))).toEqual(['first', 'second']);
  });

  it('preserves a child typed error code while replacing its arbitrary message', async () => {
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('bad.txt', bytes('bad'));
    });
    addTextReader(readers, () => {
      throw new CorruptFileError('private content');
    });
    const doc = await createExtractor(readers)(bytes('parent'), { format: 'fake' });
    expect(doc.children[0]!.error).toEqual({
      code: 'CORRUPT_FILE',
      message: 'The child document could not be read.',
    });
  });

  it('aborts before loading a reader for an already-aborted signal', async () => {
    const { registry: readers, load } = registry();
    const controller = new AbortController();
    controller.abort('private reason');
    await expect(
      createExtractor(readers)(bytes('root'), { format: 'fake', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
    expect(load).not.toHaveBeenCalled();
  });

  it('aborts an asynchronously stalled reader promptly and signals its budget', async () => {
    let context: ReadContext | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { registry: readers } = registry(async (ctx) => {
      context = ctx;
      started();
      await new Promise<void>(() => {});
    });
    const controller = new AbortController();
    const extraction = createExtractor(readers)(bytes('root'), { format: 'fake', signal: controller.signal });
    await ready;
    controller.abort();
    await expect(extraction).rejects.toMatchObject({ code: 'ABORTED' });
    expect(() => context!.budget.tick()).toThrowError('Extraction was aborted by the caller.');
  });

  it('times out a stalled reader and prevents later emissions under its budget', async () => {
    vi.useFakeTimers();
    let context: ReadContext | undefined;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { registry: readers } = registry(async (ctx) => {
      context = ctx;
      started();
      await new Promise<void>(() => {});
    });
    const extraction = createExtractor(readers)(bytes('root'), { format: 'fake', limits: { timeMs: 5 } });
    const rejection = expect(extraction).rejects.toMatchObject({ code: 'TIMEOUT', timeMs: 5 });
    await ready;
    await vi.advanceTimersByTimeAsync(6);
    await rejection;
    expect(() => context!.budget.tick()).toThrowError('Extraction was aborted by the caller.');
  });

  it('cancels a stalled input stream on timeout', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
    const extraction = createExtractor(new ReaderRegistry())(stream, { limits: { timeMs: 5 } });
    const rejection = expect(extraction).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(6);
    await rejection;
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(stream.locked).toBe(false);
  });

  it('propagates global abort while a child is running', async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { registry: readers } = registry(async (ctx) => {
      await ctx.extractChild('a.txt', bytes('leaf'));
    });
    addTextReader(readers, async () => {
      started();
      await new Promise<void>(() => {});
    });
    const controller = new AbortController();
    const extraction = createExtractor(readers)(bytes('root'), { format: 'fake', signal: controller.signal });
    await ready;
    controller.abort();
    await expect(extraction).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

/// <reference types="node" />

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createNodeExtract } from '../../src/node/file.js';
import { extract, extractFile } from '../../src/node/index.js';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader, ReadContext } from '../../src/core/reader.js';
import { AbortError, LimitExceededError } from '../../src/core/errors.js';

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);

function makeExtractor(onRead: (ctx: ReadContext) => void = () => {}) {
  const registry = new ReaderRegistry();
  const reader: Reader = {
    id: 'fake',
    mimeTypes: ['application/x-fake'],
    read(ctx) {
      onRead(ctx);
      ctx.out.paragraph(new TextDecoder().decode(ctx.bytes));
      return Promise.resolve();
    },
  };
  registry.add({ id: 'fake', mimeTypes: reader.mimeTypes, load: () => Promise.resolve(reader) });
  return createNodeExtract(createExtractor(registry));
}

describe('Node input adapter', () => {
  const directories: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  async function tempFile(name: string, content: Uint8Array): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'docsluice-node-'));
    directories.push(directory);
    const path = join(directory, name);
    await writeFile(path, content);
    return path;
  }

  it('rejects an oversized file before creating a read stream', async () => {
    const path = await tempFile('too-large.fake', bytes('12345'));
    const read = vi.fn(createReadStream);

    await expect(
      createNodeExtract(createExtractor(new ReaderRegistry()), { createReadStream: read }).extractFile(path, {
        format: 'fake',
        limits: { inputBytes: 4 },
      }),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(read).not.toHaveBeenCalled();
  });

  it('streams a file to the core extractor with its basename hint', async () => {
    let observed: ReadContext | undefined;
    const path = await tempFile('report.fake', bytes('file content'));
    const document = await makeExtractor((ctx) => {
      observed = ctx;
    }).extractFile(path, { format: 'fake' });

    expect(document.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'file content' });
    expect(observed?.filename).toBe('report.fake');
    expect(observed?.bytes.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(observed?.bytes)).toBe(false);
  });

  it('extracts a real CSV file and a Node Readable through the public docsluice/node entry', async () => {
    const path = await tempFile('x.csv', bytes('name,count\npaper,3\n'));
    const fromFile = await extractFile(path);
    expect(fromFile.format).toBe('csv');
    expect(fromFile.blocks[0]).toMatchObject({
      kind: 'table',
      rows: [
        [{ text: 'name' }, { text: 'count' }],
        [{ text: 'paper' }, { text: '3' }],
      ],
    });
    const fromStream = await extract(Readable.from([Buffer.from('# Title\n\nBody')]), {
      filename: 'notes.md',
    });
    expect(fromStream.format).toBe('markdown');
    await expect(extractFile(path, { limits: { inputBytes: 4 } })).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
    });
  });

  it('converts Node Readable chunks to plain Uint8Array before calling core', async () => {
    let observed: ReadContext | undefined;
    const document = await makeExtractor((ctx) => {
      observed = ctx;
    }).extract(Readable.from([Buffer.from('stream '), Buffer.from('content')]), { format: 'fake' });

    expect(document.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'stream content' });
    expect(observed?.bytes.constructor).toBe(Uint8Array);
    expect(Buffer.isBuffer(observed?.bytes)).toBe(false);
  });

  it('passes supported core byte inputs through the Node wrapper', async () => {
    const document = await makeExtractor().extract(bytes('core bytes'), { format: 'fake' });

    expect(document.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'core bytes' });
  });

  it('applies inputBytes to a Node Readable and closes it on overflow', async () => {
    const stream = Readable.from([Buffer.from('12345')]);

    await expect(
      makeExtractor().extract(stream, { format: 'fake', limits: { inputBytes: 4 } }),
    ).rejects.toBeInstanceOf(LimitExceededError);
    expect(stream.destroyed).toBe(true);
  });

  it('aborts a pending Node Readable extraction and destroys the stream', async () => {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stream = new Readable({
      read() {
        this.push(Buffer.from('first'));
        markStarted();
      },
    });
    const controller = new AbortController();
    const extraction = makeExtractor().extract(stream, { format: 'fake', signal: controller.signal });
    await started;
    controller.abort();

    await expect(extraction).rejects.toBeInstanceOf(AbortError);
    expect(stream.destroyed).toBe(true);
  });

  it('destroys a Node Readable when core rejects invalid limits before reading it', async () => {
    const stream = Readable.from([Buffer.from('payload')]);

    await expect(
      makeExtractor().extract(stream, { format: 'fake', limits: { inputBytes: -1 } }),
    ).rejects.toMatchObject({ name: 'RangeError' });
    expect(stream.destroyed).toBe(true);
  });

  it('closes an object-mode Node Readable when a non-byte chunk is rejected', async () => {
    const stream = Readable.from([{ value: 'not bytes' }], { objectMode: true });

    await expect(makeExtractor().extract(stream, { format: 'fake' })).rejects.toThrow(
      'Node Readable inputs must emit byte chunks.',
    );
    expect(stream.destroyed).toBe(true);
  });

  it('destroys a file stream when core setup rejects after the file passes stat', async () => {
    const path = await tempFile('valid.fake', bytes('payload'));
    let stream: ReturnType<typeof createReadStream> | undefined;
    const makeReadStream = vi.fn((filePath: Parameters<typeof createReadStream>[0]) => {
      stream = createReadStream(filePath);
      return stream;
    });
    const extract = createNodeExtract(createExtractor(new ReaderRegistry()), {
      createReadStream: makeReadStream,
    });

    await expect(extract.extractFile(path, { signal: {} as AbortSignal })).rejects.toMatchObject({
      name: 'TypeError',
    });
    expect(makeReadStream).toHaveBeenCalledOnce();
    expect(stream?.destroyed).toBe(true);
  });
});

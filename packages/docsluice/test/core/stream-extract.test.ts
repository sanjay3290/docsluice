import { describe, expect, it } from 'vitest';
import { createExtractor, createStreamExtractor } from '../../src/core/extract.js';
import type { Reader, ReadContext } from '../../src/core/reader.js';
import { ReaderRegistry } from '../../src/core/registry.js';

function textReader(onReadStream?: (ctx: ReadContext) => Promise<void>): Reader {
  return {
    id: 'csv',
    mimeTypes: ['text/csv'],
    read(ctx) {
      const text = new TextDecoder().decode(ctx.bytes);
      for (const line of text.split(/\r?\n/u)) {
        if (line) ctx.out.paragraph(line);
      }
      return Promise.resolve();
    },
    ...(onReadStream ? { readStream: onReadStream } : {}),
  };
}

function registry(reader: Reader): ReaderRegistry {
  const result = new ReaderRegistry();
  result.add({ id: 'csv', mimeTypes: ['text/csv'], load: () => Promise.resolve(reader) });
  return result;
}

function rows(text: string, pieceSize = 32): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + pieceSize, bytes.byteLength);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
}

async function readLines(ctx: ReadContext): Promise<void> {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of ctx.input!.chunks()) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/u, '');
      if (line) {
        ctx.out.paragraph(line);
        await ctx.out.flush();
      }
      pending = pending.slice(newline + 1);
      newline = pending.indexOf('\n');
    }
  }
  pending += decoder.decode();
  if (pending) {
    ctx.out.paragraph(pending.replace(/\r$/u, ''));
    await ctx.out.flush();
  }
}

describe('extractStream', () => {
  it('returns the same blocks in order as extract for an incremental reader', async () => {
    const content = 'name,value\nAda,1\nLin,2\n';
    const reader = textReader(readLines);
    const expected = await createExtractor(registry(reader))(new TextEncoder().encode(content), {
      filename: 'records.csv',
    });
    const stream = createStreamExtractor(registry(reader))(rows(content), { filename: 'records.csv' });
    const actual = [];
    for await (const block of stream) actual.push(block);
    const result = await stream.result;
    expect(actual).toEqual(expected.blocks);
    expect(result.blocks).toEqual(expected.blocks);
  });

  it('stops an incremental reader and cancels its pending input after the first block', async () => {
    const content = Array.from({ length: 50_000 }, (_, index) => `row${index},value${index}\n`).join('');
    let pulled = 0;
    let cancelled = false;
    const bytes = new TextEncoder().encode(content);
    let offset = 0;
    const input = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 32, bytes.byteLength);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
      cancel() {
        cancelled = true;
      },
    });
    const stream = createStreamExtractor(registry(textReader(readLines)))(input, { format: 'csv' });
    for await (const block of stream) {
      expect(block.kind).toBe('paragraph');
      break;
    }
    await expect(stream.result).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
    expect(pulled).toBeLessThan(bytes.byteLength / 32);
  });

  it('keeps a slow-consumer large CSV reader to one outstanding block', async () => {
    const content = Array.from({ length: 5_000 }, (_, index) => `row${index},${index}\n`).join('');
    let outstanding = 0;
    let maxOutstanding = 0;
    const reader = textReader(async (ctx) => {
      const decoder = new TextDecoder();
      let pending = '';
      for await (const chunk of ctx.input!.chunks()) {
        pending += decoder.decode(chunk, { stream: true });
        let newline = pending.indexOf('\n');
        while (newline >= 0) {
          ctx.budget.tick();
          const line = pending.slice(0, newline);
          if (line) {
            ctx.out.paragraph(line);
            outstanding += 1;
            maxOutstanding = Math.max(maxOutstanding, outstanding);
            await ctx.out.flush();
            outstanding -= 1;
          }
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
      }
      pending += decoder.decode();
      if (pending) {
        ctx.out.paragraph(pending);
        outstanding += 1;
        maxOutstanding = Math.max(maxOutstanding, outstanding);
        await ctx.out.flush();
        outstanding -= 1;
      }
    });
    const stream = createStreamExtractor(registry(reader))(rows(content, 128), { format: 'csv' });
    let count = 0;
    for await (const block of stream) {
      count += 1;
      expect(block.kind).toBe('paragraph');
      await Promise.resolve();
    }
    const document = await stream.result;
    expect(count).toBe(5_000);
    expect(document.blocks).toHaveLength(5_000);
    expect(maxOutstanding).toBe(1);
  });

  it('keeps legacy readers working without flush and yields their blocks after extraction', async () => {
    const legacy = textReader();
    const stream = createStreamExtractor(registry(legacy))(rows('one\ntwo\nthree\n'), { format: 'csv' });
    const blocks = [];
    for await (const block of stream) blocks.push(block);
    expect(blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual([
      'one',
      'two',
      'three',
    ]);
    await expect(stream.result).resolves.toHaveProperty('blocks', blocks);
  });

  it('propagates a reader timeout and cancels the source', async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 + 4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const slowReader = textReader(async () => new Promise<void>((resolve) => setTimeout(resolve, 40)));
    const stream = createStreamExtractor(registry(slowReader))(input, {
      format: 'csv',
      limits: { timeMs: 1 },
    });
    const blocksPromise = (async () => {
      for await (const block of stream) {
        void block;
        /* drain */
      }
    })();
    await expect(blocksPromise).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(stream.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });

  it('propagates a caller abort and releases a blocked source', async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('a,b\n1,2\n'));
        // The incremental reader remains blocked until it is cancelled.
      },
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const waitReader = textReader(async (ctx) => {
      for await (const chunk of ctx.input!.chunks()) {
        void chunk;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    });
    const stream = createStreamExtractor(registry(waitReader))(input, {
      format: 'csv',
      signal: controller.signal,
    });
    const blocksPromise = (async () => {
      for await (const block of stream) {
        void block;
        /* drain */
      }
    })();
    controller.abort();
    await expect(blocksPromise).rejects.toMatchObject({ code: 'ABORTED' });
    await expect(stream.result).rejects.toMatchObject({ code: 'ABORTED' });
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });

  it('cleans up the stream source after a reader error', async () => {
    let cancelled = false;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 + 4));
      },
      cancel() {
        cancelled = true;
      },
    });
    const failingReader = textReader(async (ctx) => {
      ctx.out.paragraph('first');
      await ctx.out.flush();
      throw new Error('do not expose input or implementation details');
    });
    const stream = createStreamExtractor(registry(failingReader))(input, { format: 'csv' });
    await expect(
      (async () => {
        for await (const block of stream) {
          void block;
          /* drain */
        }
      })(),
    ).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
    await expect(stream.result).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
    expect(cancelled).toBe(true);
    expect(input.locked).toBe(false);
  });
});

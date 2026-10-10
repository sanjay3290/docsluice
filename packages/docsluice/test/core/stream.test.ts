import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createRegistry,
  extract,
  extractStream,
  READER_CONTRACT_VERSION,
  type Block,
  type ExtractOptions,
  type FormatPlugin,
} from '../../src/index.js';

const corpus = new URL('../../../../corpus/', import.meta.url);
const file = (path: string) => new Uint8Array(readFileSync(new URL(path, corpus)));

async function collect(stream: AsyncIterable<Block>): Promise<Block[]> {
  const blocks: Block[] = [];
  for await (const block of stream) blocks.push(block);
  return blocks;
}

/** A plugin that emits `total` paragraphs, yielding after each, and records how far it got. */
function counter(total: number): { plugin: FormatPlugin; progress: { emitted: number } } {
  const progress = { emitted: 0 };
  return {
    progress,
    plugin: {
      id: 'counter',
      contract: READER_CONTRACT_VERSION,
      extensions: ['count'],
      async read(ctx) {
        for (let index = 0; index < total; index++) {
          ctx.budget.tick();
          if (!ctx.out.paragraph(`paragraph ${index}`)) return;
          progress.emitted++;
          await ctx.out.flush();
        }
      },
    },
  };
}

describe('extractStream', () => {
  it.each([
    'docx/headings-outline.docx',
    'xlsx/workbook-values-formulas.xlsx',
    'eml/mixed-order-attachments.eml',
    'html/blog-post.html',
    'rtf/notes-comments-revisions.rtf',
    'csv/rfc4180-crlf.csv',
  ])('gives the same blocks, in the same order and with the same offsets, as extract(): %s', async (path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const options: ExtractOptions = { filename: name };
    const stream = extractStream(file(path), options);
    const streamed = await collect(stream);
    const document = await extract(file(path), options);
    expect(streamed).toEqual(document.blocks);
    // Durations differ between runs; everything else is identical.
    const timeless = (value: unknown): unknown =>
      JSON.parse(JSON.stringify(value, (key, item: unknown) => (key === 'durationMs' ? 0 : item)));
    expect(timeless(await stream.result)).toEqual(timeless(document));
  });

  it('stops the reader when the consumer breaks after the first block', async () => {
    const { plugin, progress } = counter(10_000);
    const registry = createRegistry();
    registry.registerFormat(plugin);
    const stream = extractStream(new Uint8Array([1]), { registry, filename: 'x.count' });
    for await (const block of stream) {
      expect(block).toMatchObject({ kind: 'paragraph', text: 'paragraph 0' });
      break;
    }
    await expect(stream.result).rejects.toMatchObject({ code: 'ABORTED' });
    // The reader paused at the high-water mark and then stopped; it never ran to the end.
    expect(progress.emitted).toBeLessThan(40);
  });

  it('keeps buffered blocks bounded with a slow consumer on a large CSV', async () => {
    const rows = Array.from({ length: 60_000 }, (_, index) => `${index},name ${index},${index * 2}`).join(
      '\n',
    );
    let produced = 0;
    let consumed = 0;
    let mostBuffered = 0;
    const stream = extractStream(new TextEncoder().encode(rows), {
      format: 'csv',
      onBlock: () => {
        produced++;
        mostBuffered = Math.max(mostBuffered, produced - consumed);
      },
    });
    for await (const block of stream) {
      expect(block.kind).toBe('table');
      consumed++;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(consumed).toBe(60);
    expect(mostBuffered).toBeLessThanOrEqual(17);
    expect((await stream.result).blocks).toHaveLength(60);
  });

  it('passes reader errors to the loop and to result, and honours the caller signal', async () => {
    const failing: FormatPlugin = {
      id: 'failing',
      contract: READER_CONTRACT_VERSION,
      extensions: ['fail'],
      read: () => Promise.reject(new Error('reader bug')),
    };
    const registry = createRegistry();
    registry.registerFormat(failing);
    const stream = extractStream(new Uint8Array([1]), { registry, filename: 'x.fail' });
    await expect(collect(stream)).rejects.toMatchObject({ code: 'CORRUPT_FILE' });
    await expect(stream.result).rejects.toMatchObject({ code: 'CORRUPT_FILE' });

    const { plugin } = counter(1_000_000);
    const second = createRegistry();
    second.registerFormat(plugin);
    const controller = new AbortController();
    const aborted = extractStream(new Uint8Array([1]), {
      registry: second,
      filename: 'x.count',
      signal: controller.signal,
    });
    let seen = 0;
    await expect(
      (async () => {
        for await (const block of aborted) {
          expect(block.kind).toBe('paragraph');
          if (++seen === 3) controller.abort();
        }
      })(),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('calls onBlock for the top-level blocks of the document only, with final offsets', async () => {
    const seen: Block[] = [];
    const document = await extract(file('eml/mixed-order-attachments.eml'), {
      filename: 'mail.eml',
      onBlock: (block) => seen.push(block),
    });
    expect(seen).toEqual(document.blocks);
  });
});

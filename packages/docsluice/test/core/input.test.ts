import { afterEach, describe, expect, it, vi } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { LimitExceededError } from '../../src/core/errors.js';
import { resolveLimits } from '../../src/core/limits.js';
import { readInput } from '../../src/core/input.js';

afterEach(() => vi.restoreAllMocks());

function budget(inputBytes = 100): Budget {
  return new Budget(resolveLimits({ inputBytes }));
}

describe('readInput', () => {
  it('returns bytes from a Uint8Array', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const limits = budget();

    await expect(readInput(bytes, limits)).resolves.toEqual(bytes);
    expect(limits.inputBytes).toBe(3);
  });

  it('accepts a Node Buffer as a Uint8Array subclass', async () => {
    const nodeBuffer = (
      globalThis as typeof globalThis & { Buffer: { from(input: number[]): Uint8Array } }
    ).Buffer.from([1, 2, 3]);

    const output = await readInput(nodeBuffer, budget());

    expect(output).toBeInstanceOf(Uint8Array);
    expect(Array.from(output)).toEqual([1, 2, 3]);
  });

  it('returns bytes from an ArrayBuffer', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;

    await expect(readInput(bytes, budget())).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('respects the byte offset and length of an ArrayBufferView', async () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4]);
    const view = new DataView(backing.buffer, 1, 3);

    await expect(readInput(view, budget())).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('returns Blob bytes after checking and counting its declared size', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const limits = budget();

    await expect(readInput(blob, limits)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(limits.inputBytes).toBe(3);
  });

  it('accepts File through its Blob interface', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'input.bin');

    await expect(readInput(file, budget())).resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects an oversized Blob before reading it', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const read = vi.spyOn(blob, 'arrayBuffer');

    await expect(readInput(blob, budget(2))).rejects.toEqual(new LimitExceededError('inputBytes', 2));
    expect(read).not.toHaveBeenCalled();
  });

  it('joins stream chunks and counts each chunk', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });
    const limits = budget();

    await expect(readInput(stream, limits)).resolves.toEqual(new Uint8Array([1, 2, 3]));
    expect(limits.inputBytes).toBe(3);
    expect(stream.locked).toBe(false);
  });

  it('preserves stream chunk bytes when the source reuses its buffer', async () => {
    const reused = new Uint8Array(1);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          reused[0] = ++pulls;
          controller.enqueue(reused);
          if (pulls === 2) controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readInput(stream, budget())).resolves.toEqual(new Uint8Array([1, 2]));
  });

  it('ticks the budget while copying collected stream chunks', async () => {
    const controller = new AbortController();
    const reason = new Error('stop while joining');
    const limits = new Budget(resolveLimits(), { signal: controller.signal });
    const stream = new ReadableStream<Uint8Array>({
      start(source) {
        source.enqueue(new Uint8Array([1]));
        source.enqueue(new Uint8Array([2]));
        source.close();
      },
    });
    const tick = limits.tick.bind(limits);
    vi.spyOn(limits, 'tick').mockImplementation(() => {
      if (limits.inputBytes === 2 && !stream.locked) controller.abort(reason);
      tick();
    });

    await expect(readInput(stream, limits)).rejects.toMatchObject({
      name: 'AbortError',
      cause: reason,
    });
  });

  it('cancels and unlocks a stream that yields a non-Uint8Array chunk', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue('invalid chunk' as unknown as Uint8Array);
      },
      cancel,
    });

    await expect(readInput(stream, budget())).rejects.toThrow(
      'ReadableStream input must yield Uint8Array chunks.',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it('stops reading a stream as soon as the byte count exceeds the limit', async () => {
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      },
      { highWaterMark: 0 },
    );

    await expect(readInput(stream, budget(2))).rejects.toEqual(new LimitExceededError('inputBytes', 2));
    expect(pulls).toBe(1);
    expect(stream.locked).toBe(false);
  });

  it('cancels a pending stream read promptly when its signal aborts', async () => {
    const controller = new AbortController();
    const reason = new Error('caller stopped');
    let cancelReason: unknown;
    const stream = new ReadableStream<Uint8Array>(
      {
        cancel(value) {
          cancelReason = value;
        },
        pull() {
          return new Promise<void>(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const limits = new Budget(resolveLimits(), { signal: controller.signal });
    const pending = readInput(stream, limits);
    controller.abort(reason);

    await expect(pending).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORTED',
      cause: reason,
    });
    expect(cancelReason).toBe(reason);
    expect(stream.locked).toBe(false);
  });

  it('releases a stream lock when the source errors', async () => {
    const failure = new Error('stream failed');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });

    await expect(readInput(stream, budget())).rejects.toBe(failure);
    expect(stream.locked).toBe(false);
  });

  it('throws a clear TypeError for unsupported inputs', async () => {
    await expect(readInput('file.pdf', budget())).rejects.toThrow(
      'Unsupported input. Expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, or ReadableStream<Uint8Array>.',
    );
  });
});

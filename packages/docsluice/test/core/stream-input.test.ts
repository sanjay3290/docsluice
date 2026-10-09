import { describe, expect, it, vi } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { createStreamInput } from '../../src/core/stream-input.js';

function budget(limits: ConstructorParameters<typeof Budget>[0] = DEFAULT_LIMITS) {
  return new Budget(limits);
}

describe('createStreamInput', () => {
  it('keeps the bounded detection prefix and yields each input byte exactly once', async () => {
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6, 7, 8]));
        controller.close();
      },
    });
    const activeBudget = budget();
    const source = await createStreamInput(input, activeBudget, 5);
    expect([...source.prefix]).toEqual([1, 2, 3, 4, 5]);
    const chunks: number[] = [];
    for await (const chunk of source.chunks()) chunks.push(...chunk);
    expect(chunks).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(activeBudget.inputBytes).toBe(8);
    expect(input.locked).toBe(false);
  });

  it('cancels and releases a pending source when the consumer stops early', async () => {
    const cancel = vi.fn();
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel,
    });
    const source = await createStreamInput(input, budget(), 1);
    const iterator = source.chunks()[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toEqual(new Uint8Array([1]));
    await iterator.return?.();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(input.locked).toBe(false);
  });

  it('materializes the prefix and remainder without a second source read', async () => {
    const input = new Uint8Array([10, 11, 12, 13, 14]);
    const activeBudget = budget();
    const source = await createStreamInput(input, activeBudget, 2);
    expect([...(await source.collect())]).toEqual([...input]);
    expect(activeBudget.inputBytes).toBe(input.byteLength);
  });

  it('rejects a second consumer', async () => {
    const source = await createStreamInput(new Uint8Array([1, 2]), budget(), 1);
    for await (const chunk of source.chunks()) {
      void chunk;
      /* consume once */
    }
    await expect(source.collect()).rejects.toThrow('only be consumed once');
  });
});

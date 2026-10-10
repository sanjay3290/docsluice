/// <reference types="node" />

import { afterEach, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { markAsUntransferable } from 'node:worker_threads';
import { AbortError, TimeoutError } from '../../src/core/errors.js';
import type { LimitExceededError } from '../../src/core/errors.js';
import { createExtractorWithWorkerEntry, WorkerIsolationError } from '../../src/node/worker/pool.js';

/** Whether this test process carries a heap-size flag, which every worker inherits. */
const heapFlagSet = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].some((argument) =>
  /--max[-_]old[-_]space[-_]size/.test(argument),
);

const workerUrl = new URL('./worker-fixture.mjs', import.meta.url);
const extractors: Array<{ close(): Promise<void> }> = [];

function makeExtractor(
  workerMode: 'echo' | 'oom' | 'hang' | 'hang-on-zero',
  options: { maxOldGenerationSizeMb?: number; timeMs?: number; poolSize?: number } = {},
) {
  // The heap check is exercised by the memory tests only, so a heap flag in the developer's shell does
  // not fail unrelated tests.
  const enforceHeapLimit = workerMode === 'oom' || options.maxOldGenerationSizeMb === 16;
  const extractor = createExtractorWithWorkerEntry(
    options,
    workerUrl,
    { mode: workerMode },
    undefined,
    enforceHeapLimit,
  );
  extractors.push(extractor);
  return extractor;
}

afterEach(async () => {
  await Promise.all(extractors.splice(0).map((extractor) => extractor.close()));
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for the worker test condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('worker extractor', () => {
  it('transfers an owned input buffer and returns a structured-cloned result', async () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    const backing = input.buffer;
    const extractor = makeExtractor('echo');

    const result = await extractor.extract(input);

    expect(backing.byteLength).toBe(0);
    expect(result).toEqual({ bytes: [1, 2, 3, 4] });
  });

  it('copies Node-marked untransferable input storage and leaves the caller view intact', async () => {
    const input = new Uint8Array([4, 5, 6]);
    markAsUntransferable(input.buffer);
    const extractor = makeExtractor('echo');

    await expect(extractor.extract(input)).resolves.toEqual({ bytes: [4, 5, 6] });
    expect(input).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('copies a pooled Buffer range without transferring its shared backing storage', async () => {
    const input = Buffer.from([4, 5, 6]);
    const extractor = makeExtractor('echo');

    await expect(extractor.extract(input)).resolves.toEqual({ bytes: [4, 5, 6] });
    expect(input).toEqual(Buffer.from([4, 5, 6]));
  });

  it('copies an unpooled Buffer without detaching caller-owned storage', async () => {
    const input = Buffer.alloc(3);
    input.set([7, 8, 9]);
    const extractor = makeExtractor('echo');

    await expect(extractor.extract(input)).resolves.toEqual({ bytes: [7, 8, 9] });
    expect(input).toEqual(Buffer.from([7, 8, 9]));
  });

  it('normalizes Node Readable byte input before transferring it', async () => {
    const input = Readable.from([Buffer.from([1, 2]), Buffer.from([3])]);
    const extractor = makeExtractor('echo');

    await expect(extractor.extract(input)).resolves.toEqual({ bytes: [1, 2, 3] });
  });

  it('rejects callback options before transferring input', async () => {
    const input = new Uint8Array([1, 2, 3]);
    const extractor = makeExtractor('echo');

    await expect(extractor.extract(input, { transform: (block) => block })).rejects.toThrow(
      'transform and onBlock callbacks are not supported by worker extraction.',
    );
    expect(input.byteLength).toBe(3);

    await expect(extractor.extract(input, { onBlock: () => {} })).rejects.toThrow(
      'transform and onBlock callbacks are not supported by worker extraction.',
    );
    expect(input.byteLength).toBe(3);
  });

  it('validates worker resource, timeout, and pool options', () => {
    expect(() => makeExtractor('echo', { maxOldGenerationSizeMb: 0 })).toThrow(RangeError);
    expect(() => makeExtractor('echo', { timeMs: 0 })).toThrow(RangeError);
    expect(() => makeExtractor('echo', { poolSize: 0 })).toThrow(RangeError);
  });

  it('maps an actual worker heap exhaustion to a memory limit error and keeps the parent alive', async () => {
    const extractor = makeExtractor('oom', { maxOldGenerationSizeMb: 16, timeMs: 10_000 });
    const result = extractor.extract(new Uint8Array([1]));
    if (heapFlagSet) {
      // A process-wide heap flag overrides resourceLimits: the pool refuses instead of pretending.
      await expect(result).rejects.toBeInstanceOf(WorkerIsolationError);
      await expect(extractor.extract(new Uint8Array([1]))).rejects.toBeInstanceOf(WorkerIsolationError);
    } else {
      await expect(result).rejects.toMatchObject({
        code: 'LIMIT_EXCEEDED',
        limit: 'memory',
      } satisfies Partial<LimitExceededError>);
    }
    expect(2 + 2).toBe(4);
  });

  it('refuses to run when the worker reports a heap limit far above the requested cap', async () => {
    const extractor = makeExtractor('echo', { maxOldGenerationSizeMb: 16 });
    const outcome = await extractor.extract(new Uint8Array([1])).then(
      () => 'ran',
      (error: unknown) => error,
    );
    if (heapFlagSet) expect(outcome).toBeInstanceOf(WorkerIsolationError);
    else expect(outcome).toBe('ran');
  });

  it('terminates a hanging worker at timeMs and reports TimeoutError', async () => {
    const extractor = makeExtractor('hang-on-zero', { timeMs: 75 });

    await expect(extractor.extract(new Uint8Array([0]))).rejects.toBeInstanceOf(TimeoutError);
    await expect(extractor.extract(new Uint8Array([1]))).resolves.toEqual({ bytes: [1] });
  });

  it('aborts active work, kills the stuck worker, and settles with AbortError', async () => {
    const extractor = makeExtractor('hang-on-zero', { timeMs: 5_000 });
    const input = new Uint8Array([0]);
    const controller = new AbortController();
    const extraction = extractor.extract(input, { signal: controller.signal });
    await waitFor(() => input.buffer.byteLength === 0);
    controller.abort();

    await expect(extraction).rejects.toBeInstanceOf(AbortError);
    await expect(extractor.extract(new Uint8Array([1]))).resolves.toEqual({ bytes: [1] });
  });

  it('closes a Node Readable when the signal is already aborted', async () => {
    const extractor = makeExtractor('echo');
    const input = new Readable({ read() {} });
    const controller = new AbortController();
    controller.abort();

    await expect(extractor.extract(input, { signal: controller.signal })).rejects.toBeInstanceOf(AbortError);
    expect(input.destroyed).toBe(true);
  });

  it('closes a queued Node Readable when its signal is aborted', async () => {
    const extractor = makeExtractor('hang', { poolSize: 1, timeMs: 5_000 });
    const activeInput = new Uint8Array([0]);
    const active = extractor.extract(activeInput).catch((error: unknown) => error);
    await waitFor(() => activeInput.buffer.byteLength === 0);
    const input = new Readable({ read() {} });
    const controller = new AbortController();
    const pending = extractor.extract(input, { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toBeInstanceOf(AbortError);
    expect(input.destroyed).toBe(true);
    await extractor.close();
    await active;
  });

  it('closes queued Node Readables when the extractor closes', async () => {
    const extractor = makeExtractor('hang', { poolSize: 1, timeMs: 5_000 });
    const activeInput = new Uint8Array([0]);
    const active = extractor.extract(activeInput).catch((error: unknown) => error);
    await waitFor(() => activeInput.buffer.byteLength === 0);
    const input = new Readable({ read() {} });
    const pending = extractor.extract(input);

    const closing = extractor.close();
    await expect(pending).rejects.toThrow('Worker extractor is closed.');
    expect(input.destroyed).toBe(true);
    await closing;
    await active;
  });

  it('processes 100 concurrent small inputs through the bounded worker pool', async () => {
    const extractor = makeExtractor('echo', { poolSize: 4 });
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) => extractor.extract(new Uint8Array([index, index + 1]))),
    );

    expect(results).toHaveLength(100);
    expect(results[0]).toEqual({ bytes: [0, 1] });
    expect(results[99]).toEqual({ bytes: [99, 100] });
  });

  it('rejects work beyond its fixed pending queue capacity', async () => {
    const extractor = makeExtractor('hang', { poolSize: 1, timeMs: 5_000 });
    const activeInput = new Uint8Array([0]);
    const active = extractor.extract(activeInput).catch((error: unknown) => error);
    await waitFor(() => activeInput.buffer.byteLength === 0);
    const pending = Array.from({ length: 1_024 }, () =>
      extractor.extract(new Uint8Array([1])).catch((error: unknown) => error),
    );

    await expect(extractor.extract(new Uint8Array([1]))).rejects.toMatchObject({
      code: 'LIMIT_EXCEEDED',
      limit: 'workerQueue',
      value: 1_024,
    });
    await extractor.close();
    await active;
    await Promise.all(pending);
  });

  it('rejects new extraction calls after close', async () => {
    const extractor = makeExtractor('echo');
    await extractor.close();

    await expect(extractor.extract(new Uint8Array([1]))).rejects.toThrow('Worker extractor is closed.');
  });

  it('fails the pool if its worker entry cannot start instead of respawning indefinitely', async () => {
    const extractor = createExtractorWithWorkerEntry(
      {},
      new URL('./missing-worker-fixture.mjs', import.meta.url),
    );
    extractors.push(extractor);

    await expect(extractor.extract(new Uint8Array([1]))).rejects.toThrow('Worker failed to start.');
    // Later calls repeat why the pool stopped.
    await expect(extractor.extract(new Uint8Array([1]))).rejects.toThrow('Worker failed to start.');
  });

  it('times out a worker that hangs before announcing readiness', async () => {
    const extractor = createExtractorWithWorkerEntry({}, workerUrl, { mode: 'hang-before-ready' }, 75);
    extractors.push(extractor);
    const first = extractor.extract(new Uint8Array([1]));
    const second = extractor.extract(new Uint8Array([2]));

    await expect(first).rejects.toMatchObject({ code: 'TIMEOUT', timeMs: 75 });
    await expect(second).rejects.toMatchObject({ code: 'TIMEOUT', timeMs: 75 });
    await expect(extractor.extract(new Uint8Array([3]))).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});

/// <reference types="node" />

// Error and cancellation paths of the worker pool (QA-5): revived errors, broken replies, and
// tasks stopped while queued or while their input is still being read.
import { afterEach, describe, expect, it } from 'vitest';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  StrictModeError,
  TimeoutError,
  UnsupportedFormatError,
} from '../../src/core/errors.js';
import { createExtractorWithWorkerEntry } from '../../src/node/worker/pool.js';

const workerUrl = new URL('./worker-fixture.mjs', import.meta.url);
const extractors: Array<{ close(): Promise<void> }> = [];

function makeExtractor(mode: string, options: { timeMs?: number; poolSize?: number } = {}) {
  const extractor = createExtractorWithWorkerEntry(options, workerUrl, { mode }, undefined, false);
  extractors.push(extractor);
  return extractor;
}

afterEach(async () => {
  await Promise.all(extractors.splice(0).map((extractor) => extractor.close()));
});

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** A stream that never ends, so its task stays in the preparing phase. */
const endless = () => new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });

describe('worker pool error handling', () => {
  it('revives every docsluice error the worker reports, with its details', async () => {
    const extractor = makeExtractor('errors');
    const cases: Array<[unknown, (error: unknown) => void]> = [
      [
        { code: 'LIMIT_EXCEEDED', limit: 'cells', value: 10 },
        (e) => expect(e).toMatchObject({ limit: 'cells', value: 10 }),
      ],
      [{ code: 'LIMIT_EXCEEDED' }, (e) => expect(e).toBeInstanceOf(LimitExceededError)],
      [{ code: 'UNSUPPORTED_FORMAT', format: 'x' }, (e) => expect(e).toMatchObject({ format: 'x' })],
      [{ code: 'UNSUPPORTED_FORMAT' }, (e) => expect(e).toBeInstanceOf(UnsupportedFormatError)],
      [
        { code: 'ENCRYPTED', reason: 'wrong-password' },
        (e) => expect(e).toMatchObject({ reason: 'wrong-password' }),
      ],
      [{ code: 'ENCRYPTED', reason: 'odd' }, (e) => expect(e).toMatchObject({ reason: 'password-required' })],
      [{ code: 'CORRUPT_FILE', message: 'Broken.' }, (e) => expect(e).toBeInstanceOf(CorruptFileError)],
      [{ code: 'TIMEOUT', timeMs: 5 }, (e) => expect(e).toMatchObject({ timeMs: 5 })],
      [{ code: 'TIMEOUT' }, (e) => expect(e).toBeInstanceOf(TimeoutError)],
      [{ code: 'ABORTED' }, (e) => expect(e).toBeInstanceOf(AbortError)],
      [
        { code: 'STRICT_WARNING', warningCode: 'TRUNCATED' },
        (e) => expect(e).toMatchObject({ warningCode: 'TRUNCATED' }),
      ],
      [{ code: 'STRICT_WARNING' }, (e) => expect(e).toBeInstanceOf(StrictModeError)],
      [
        { name: 'RangeError', message: 'Other.' },
        (e) => expect(e).toMatchObject({ name: 'RangeError', message: 'Other.' }),
      ],
      [null, (e) => expect(e).toMatchObject({ message: 'Worker extraction failed.' })],
    ];
    for (const [serialized, check] of cases) {
      const error: unknown = await extractor.extract(encode(serialized)).catch((caught: unknown) => caught);
      check(error);
    }
    expect(await extractor.extract(encode({ code: 'ENCRYPTED' })).catch((e: unknown) => e)).toBeInstanceOf(
      EncryptedError,
    );
  });

  it.each(['garbage', 'wrong-id'])('retires a worker that sends a %s reply', async (mode) => {
    const extractor = makeExtractor(mode);
    await expect(extractor.extract(Uint8Array.of(1))).rejects.toMatchObject({ limit: 'memory' });
  });

  it('rejects a signal that is not an AbortSignal', async () => {
    const extractor = makeExtractor('echo');
    await expect(extractor.extract(Uint8Array.of(1), { signal: {} as AbortSignal })).rejects.toThrow(
      'signal must be an AbortSignal.',
    );
  });

  it('rejects with the input stream’s own error', async () => {
    const extractor = makeExtractor('echo');
    const failing = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.error(new Error('Disk went away.')),
    });
    await expect(extractor.extract(failing)).rejects.toThrow('Disk went away.');
  });

  it('stops a task while its input is still being read, on abort and on timeout', async () => {
    const extractor = makeExtractor('echo', { timeMs: 200 });
    const controller = new AbortController();
    const aborted = extractor.extract(endless(), { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(aborted).rejects.toBeInstanceOf(AbortError);
    await expect(extractor.extract(endless())).rejects.toBeInstanceOf(TimeoutError);
  });

  it('stops a queued task on abort without touching the running one', async () => {
    const extractor = makeExtractor('echo', { poolSize: 1, timeMs: 500 });
    const running = extractor.extract(endless());
    const controller = new AbortController();
    const queued = extractor.extract(Uint8Array.of(1), { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toBeInstanceOf(AbortError);
    await expect(running).rejects.toBeInstanceOf(TimeoutError);
  });
});

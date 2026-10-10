/// <reference types="node" />

import { Readable } from 'node:stream';
import { Worker } from 'node:worker_threads';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  StrictModeError,
  TimeoutError,
  UnsupportedFormatError,
} from '../../core/errors.js';
import type { ErrorCode } from '../../core/errors.js';
import { Budget } from '../../core/budget.js';
import { readInput } from '../../core/input.js';
import { resolveLimits } from '../../core/limits.js';
import type { DocsluiceDocument } from '../../core/model.js';
import type { ExtractOptions } from '../../core/options.js';
import type { WarningCode } from '../../core/model.js';

const DEFAULT_MAX_OLD_GENERATION_SIZE_MB = 256;
const DEFAULT_TIME_MS = 60_000;
const DEFAULT_POOL_SIZE = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const MAX_POOL_SIZE = 32;
const MAX_PENDING_JOBS = 1_024;
const MAX_TIMER_DELAY = 2_147_483_647;

export interface WorkerExtractorOptions {
  /** Per-worker V8 old-generation heap limit. This does not cap total process or ArrayBuffer memory. */
  maxOldGenerationSizeMb?: number;
  /** Maximum active extraction duration after a worker becomes available. Defaults to 60 seconds. */
  timeMs?: number;
  /** Number of isolated worker threads. Defaults to one; values above 32 are rejected. */
  poolSize?: number;
}

interface RequestMessage {
  id: number;
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  options: ExtractOptions;
}

interface SerializedError {
  name: string;
  message: string;
  code?: ErrorCode;
  limit?: string;
  value?: number;
  format?: string;
  reason?: string;
  timeMs?: number;
  warningCode?: WarningCode;
}

interface ResponseMessage {
  id: number;
  ok: boolean;
  result?: DocsluiceDocument;
  error?: SerializedError;
}

interface ReadyMessage {
  type: 'ready';
  /** The heap limit V8 applied in the worker, when the worker reports it. */
  heapLimitMb?: number;
}

/**
 * V8 adds about 192 MB of young-generation and other spaces to the old-generation cap. A reported
 * limit more than this far above the requested cap means a process-wide --max-old-space-size flag
 * replaced it.
 */
const HEAP_LIMIT_SLACK_MB = 512;

/** Thrown when the worker heap cap cannot be enforced, so isolation would only be pretended. */
export class WorkerIsolationError extends Error {
  constructor(requestedMb: number, actualMb: number) {
    super(
      `The worker heap limit of ${requestedMb} MB cannot be enforced: V8 applied ${actualMb} MB because a ` +
        '--max-old-space-size flag (on the command line or in NODE_OPTIONS) overrides Worker resourceLimits. ' +
        'Remove the flag, or raise maxOldGenerationSizeMb to match it.',
    );
    this.name = 'WorkerIsolationError';
  }
}

interface WorkerData {
  mode?: string;
}

interface WorkerConstruction {
  workerEntry: URL;
  workerData?: WorkerData;
  startupTimeoutMs?: number;
  /** Refuse to run when the worker's heap limit is not the requested one (always on in production). */
  enforceHeapLimit?: boolean;
}

interface Task {
  readonly id: number;
  readonly input: unknown;
  readonly options: ExtractOptions;
  readonly effectiveTimeMs: number;
  readonly signal?: AbortSignal;
  readonly resolve: (document: DocsluiceDocument) => void;
  readonly reject: (error: unknown) => void;
  phase: 'queued' | 'preparing' | 'running' | 'settled';
  timer?: ReturnType<typeof setTimeout>;
  abortController?: AbortController;
  abortHandler?: () => void;
}

interface WorkerSlot {
  readonly worker: Worker;
  ready: boolean;
  retiring: boolean;
  task?: Task;
  termination?: Promise<void>;
  startupTimer?: ReturnType<typeof setTimeout>;
}

interface NormalizedOptions {
  readonly maxOldGenerationSizeMb: number;
  readonly timeMs: number;
  readonly poolSize: number;
}

function validateOptions(options: WorkerExtractorOptions): NormalizedOptions {
  const maxOldGenerationSizeMb = options.maxOldGenerationSizeMb ?? DEFAULT_MAX_OLD_GENERATION_SIZE_MB;
  const timeMs = options.timeMs ?? DEFAULT_TIME_MS;
  const poolSize = options.poolSize ?? DEFAULT_POOL_SIZE;
  if (!Number.isSafeInteger(maxOldGenerationSizeMb) || maxOldGenerationSizeMb <= 0) {
    throw new RangeError('maxOldGenerationSizeMb must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(timeMs) || timeMs <= 0 || timeMs > MAX_TIMER_DELAY) {
    throw new RangeError(`timeMs must be an integer between 1 and ${MAX_TIMER_DELAY}.`);
  }
  if (!Number.isSafeInteger(poolSize) || poolSize < 1 || poolSize > MAX_POOL_SIZE) {
    throw new RangeError(`poolSize must be an integer between 1 and ${MAX_POOL_SIZE}.`);
  }
  return { maxOldGenerationSizeMb, timeMs, poolSize };
}

function reviveError(error: SerializedError): Error {
  switch (error.code) {
    case 'LIMIT_EXCEEDED':
      return new LimitExceededError(error.limit ?? 'unknown', error.value ?? 0);
    case 'UNSUPPORTED_FORMAT':
      return new UnsupportedFormatError(error.format ?? 'unknown');
    case 'ENCRYPTED':
      return new EncryptedError(
        error.reason === 'wrong-password' || error.reason === 'unsupported-encryption'
          ? error.reason
          : 'password-required',
      );
    case 'CORRUPT_FILE':
      return new CorruptFileError(error.message);
    case 'TIMEOUT':
      return new TimeoutError(error.timeMs ?? 0);
    case 'ABORTED':
      return new AbortError();
    case 'STRICT_WARNING':
      return new StrictModeError(error.warningCode ?? 'UNREADABLE_PART');
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  return revived;
}

function isReadyMessage(value: unknown): value is ReadyMessage {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === 'ready';
}

function isResponseMessage(value: unknown): value is ResponseMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'number' &&
    'ok' in value &&
    typeof value.ok === 'boolean'
  );
}

function transferableBytes(bytes: Uint8Array): {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
} {
  const buffer = bytes.buffer;
  // Buffer instances may share pooled storage; copy them before transfer to avoid detaching it.
  if (Buffer.isBuffer(bytes) || !(buffer instanceof ArrayBuffer)) {
    const copy = new Uint8Array(bytes);
    return { buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength };
  }
  return { buffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength };
}

function sendRequest(worker: Worker, message: RequestMessage): void {
  try {
    worker.postMessage(message, [message.buffer]);
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'DataCloneError') throw error;
    const copy = new Uint8Array(message.buffer, message.byteOffset, message.byteLength).slice();
    worker.postMessage({ ...message, buffer: copy.buffer, byteOffset: 0, byteLength: copy.byteLength }, [
      copy.buffer,
    ]);
  }
}

function webInput(input: unknown): unknown {
  return input instanceof Readable ? Readable.toWeb(input) : input;
}

function disposeInput(input: unknown, reason?: unknown): void {
  if (input instanceof Readable) {
    try {
      input.destroy();
    } catch {
      // A custom stream cleanup failure must not replace the extraction error.
    }
    return;
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { cancel?: unknown }).cancel === 'function' &&
    (input as { locked?: unknown }).locked !== true
  ) {
    try {
      void (input as ReadableStream<Uint8Array>).cancel(reason).catch(() => undefined);
    } catch {
      // The stream may have been locked or cancelled between the check and call.
    }
  }
}

function makeInputController(signal?: AbortSignal): { controller: AbortController; detach: () => void } {
  const controller = new AbortController();
  if (!signal) return { controller, detach: () => {} };
  const abort = (): void => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  return { controller, detach: () => signal.removeEventListener('abort', abort) };
}

function assertNoCallbacks(options: ExtractOptions): void {
  if (typeof options.transform === 'function' || typeof options.onBlock === 'function') {
    throw new TypeError('transform and onBlock callbacks are not supported by worker extraction.');
  }
}

function isSettled(task: Task): boolean {
  return task.phase === 'settled';
}

function cloneWorkerOptions(options: ExtractOptions, timeMs: number): ExtractOptions {
  const limits = resolveLimits(options.limits);
  limits.timeMs = Math.min(timeMs, limits.timeMs);
  return structuredClone({ ...options, limits });
}

/**
 * Create a bounded pool around an isolated worker entry. The second export is a private test seam;
 * the public `docsluice/worker` entry only exports `createExtractor` and its options type.
 */
export function createExtractorWithWorkerEntry(
  options: WorkerExtractorOptions,
  workerEntry: URL,
  workerData?: WorkerData,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  enforceHeapLimit = true,
): WorkerExtractor {
  return makeWorkerExtractor(options, {
    workerEntry,
    ...(workerData ? { workerData } : {}),
    startupTimeoutMs,
    enforceHeapLimit,
  });
}

export interface WorkerExtractor {
  extract(input: unknown, options?: ExtractOptions): Promise<DocsluiceDocument>;
  close(): Promise<void>;
}

function makeWorkerExtractor(
  options: WorkerExtractorOptions,
  construction: WorkerConstruction,
): WorkerExtractor {
  const settings = validateOptions(options);
  const startupTimeoutMs = construction.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const queue: Task[] = [];
  const slots: WorkerSlot[] = [];
  let nextId = 1;
  let closed = false;
  /** Why the pool stopped on its own; later calls reject with it. */
  let poolFailure: Error | undefined;
  let closePromise: Promise<void> | undefined;

  function createSlot(): WorkerSlot {
    const worker = new Worker(construction.workerEntry, {
      // execArgv is left to Node's default inheritance, which drops per-process options. A process-wide
      // --max-old-space-size flag still overrides resourceLimits; the ready check catches that.
      resourceLimits: { maxOldGenerationSizeMb: settings.maxOldGenerationSizeMb },
      ...(construction.workerData ? { workerData: construction.workerData } : {}),
    });
    const slot: WorkerSlot = { worker, ready: false, retiring: false };
    slots.push(slot);
    slot.startupTimer = setTimeout(() => {
      if (!slot.ready && !slot.retiring) failPool(new TimeoutError(startupTimeoutMs));
    }, startupTimeoutMs);
    worker.on('message', (message: unknown) => handleMessage(slot, message));
    worker.on('messageerror', () => {
      handleWorkerFailure(slot);
    });
    worker.on('error', () => {
      handleWorkerFailure(slot);
    });
    worker.on('exit', () => {
      handleWorkerFailure(slot);
    });
    return slot;
  }

  function memoryError(): LimitExceededError {
    return new LimitExceededError('memory', settings.maxOldGenerationSizeMb);
  }

  function failPool(error: unknown): void {
    if (closed) return;
    closed = true;
    const failure =
      error instanceof Error ? error : new Error('Worker pool could not start a replacement worker.');
    poolFailure = failure;
    for (const task of queue.splice(0)) settle(task, { ok: false, error: failure });
    for (const slot of [...slots]) {
      void retireSlot(slot, failure, false).catch(() => undefined);
    }
  }

  function handleWorkerFailure(slot: WorkerSlot): void {
    if (slot.retiring) return;
    if (!slot.ready) {
      failPool(new Error('Worker failed to start.'));
      return;
    }
    void retireSlot(slot, memoryError(), true).catch(failPool);
  }

  function clearTask(task: Task): void {
    if (task.timer !== undefined) clearTimeout(task.timer);
    if (task.signal && task.abortHandler) task.signal.removeEventListener('abort', task.abortHandler);
    task.phase = 'settled';
  }

  function settle(
    task: Task,
    result: { ok: true; document: DocsluiceDocument } | { ok: false; error: unknown },
  ): void {
    if (task.phase === 'settled') return;
    clearTask(task);
    if (result.ok) task.resolve(result.document);
    else {
      disposeInput(task.input, result.error);
      task.reject(result.error);
    }
  }

  function removeQueued(task: Task): void {
    const index = queue.indexOf(task);
    if (index >= 0) queue.splice(index, 1);
  }

  function retireSlot(slot: WorkerSlot, error: unknown, replace: boolean): Promise<void> {
    if (slot.termination) return slot.termination;
    slot.retiring = true;
    if (slot.startupTimer !== undefined) clearTimeout(slot.startupTimer);
    if (slot.task) {
      const task = slot.task;
      if (task.phase === 'preparing') {
        task.abortController?.abort(error);
        disposeInput(task.input, error);
      }
      settle(task, { ok: false, error });
      slot.task = undefined;
    }
    slot.termination = workerTermination(slot.worker).then(() => {
      const index = slots.indexOf(slot);
      if (index >= 0) slots.splice(index, 1);
      if (replace && !closed) createSlot();
      pump();
    });
    return slot.termination;
  }

  async function workerTermination(worker: Worker): Promise<void> {
    try {
      await worker.terminate();
    } catch {
      // A worker that already exited is considered terminated.
    }
  }

  function handleMessage(slot: WorkerSlot, message: unknown): void {
    if (isReadyMessage(message)) {
      const actual = message.heapLimitMb;
      if (
        construction.enforceHeapLimit !== false &&
        actual !== undefined &&
        actual > settings.maxOldGenerationSizeMb + HEAP_LIMIT_SLACK_MB
      ) {
        failPool(new WorkerIsolationError(settings.maxOldGenerationSizeMb, actual));
        return;
      }
      slot.ready = true;
      if (slot.startupTimer !== undefined) clearTimeout(slot.startupTimer);
      pump();
      return;
    }
    if (!isResponseMessage(message)) {
      void retireSlot(slot, memoryError(), true);
      return;
    }
    const task = slot.task;
    if (!task || task.phase !== 'running' || message.id !== task.id) {
      void retireSlot(slot, memoryError(), true);
      return;
    }
    if (message.ok && message.result !== undefined) settle(task, { ok: true, document: message.result });
    else
      settle(task, {
        ok: false,
        error: reviveError(message.error ?? { name: 'Error', message: 'Worker extraction failed.' }),
      });
    slot.task = undefined;
    pump();
  }

  function stopTask(slot: WorkerSlot, task: Task, error: Error): void {
    if (task.phase === 'settled') return;
    if (task.phase === 'queued') {
      removeQueued(task);
      settle(task, { ok: false, error });
      return;
    }
    if (task.phase === 'preparing') {
      task.abortController?.abort(error);
      disposeInput(task.input, error);
      settle(task, { ok: false, error });
      return;
    }
    void retireSlot(slot, error, true);
  }

  async function prepareAndSend(slot: WorkerSlot, task: Task): Promise<void> {
    task.phase = 'preparing';
    if (task.signal && task.abortHandler) task.signal.removeEventListener('abort', task.abortHandler);
    const inputController = makeInputController(task.signal);
    task.abortController = inputController.controller;
    task.abortHandler = (): void => stopTask(slot, task, new AbortError({ cause: task.signal?.reason }));
    task.signal?.addEventListener('abort', task.abortHandler, { once: true });
    task.timer = setTimeout(
      () => stopTask(slot, task, new TimeoutError(task.effectiveTimeMs)),
      task.effectiveTimeMs,
    );
    if (task.signal?.aborted) task.abortHandler();
    if (isSettled(task)) {
      inputController.detach();
      if (slot.task === task) slot.task = undefined;
      pump();
      return;
    }

    try {
      const inputLimits = resolveLimits(task.options.limits);
      const budget = new Budget(inputLimits, { signal: inputController.controller.signal });
      const bytes = await readInput(webInput(task.input), budget);
      inputController.detach();
      if (isSettled(task) || slot.retiring || closed) {
        if (slot.task === task) slot.task = undefined;
        pump();
        return;
      }
      task.phase = 'running';
      const transfer = transferableBytes(bytes);
      const message: RequestMessage = {
        id: task.id,
        ...transfer,
        options: cloneWorkerOptions(task.options, task.effectiveTimeMs),
      };
      sendRequest(slot.worker, message);
    } catch (error) {
      inputController.detach();
      disposeInput(task.input, error);
      if (!isSettled(task)) settle(task, { ok: false, error });
      if (slot.task === task) slot.task = undefined;
      pump();
    }
  }

  function pump(): void {
    if (closed) return;
    for (const slot of slots) {
      if (!slot.ready || slot.retiring || slot.task || queue.length === 0) continue;
      const task = queue.shift()!;
      slot.task = task;
      void prepareAndSend(slot, task);
    }
  }

  function extract(input: unknown, extractOptions: ExtractOptions = {}): Promise<DocsluiceDocument> {
    if (closed) {
      const error = poolFailure ?? new Error('Worker extractor is closed.');
      disposeInput(input, error);
      return Promise.reject(error);
    }
    try {
      assertNoCallbacks(extractOptions);
      if (
        extractOptions.signal !== undefined &&
        typeof extractOptions.signal.addEventListener !== 'function'
      ) {
        throw new TypeError('signal must be an AbortSignal.');
      }
      const limits = resolveLimits(extractOptions.limits);
      const effectiveTimeMs = Math.min(settings.timeMs, limits.timeMs);
      const { signal, ...optionsWithoutSignal } = extractOptions;
      const workerOptions = structuredClone(optionsWithoutSignal);
      if (signal?.aborted) {
        disposeInput(input, signal.reason);
        return Promise.reject(new AbortError({ cause: signal.reason }));
      }
      if (queue.length >= MAX_PENDING_JOBS) {
        const error = new LimitExceededError('workerQueue', MAX_PENDING_JOBS);
        disposeInput(input, error);
        return Promise.reject(error);
      }
      return new Promise<DocsluiceDocument>((resolve, reject) => {
        const task: Task = {
          id: nextId++,
          input,
          options: workerOptions,
          effectiveTimeMs,
          ...(signal ? { signal } : {}),
          resolve,
          reject,
          phase: 'queued',
        };
        task.abortHandler = (): void => {
          removeQueued(task);
          const error = new AbortError({ cause: task.signal?.reason });
          disposeInput(task.input, error);
          settle(task, { ok: false, error });
        };
        if (task.signal) task.signal.addEventListener('abort', task.abortHandler, { once: true });
        queue.push(task);
        pump();
      });
    } catch (error) {
      disposeInput(input, error);
      return Promise.reject(error instanceof Error ? error : new Error('Worker extraction failed.'));
    }
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closed = true;
    const error = new Error('Worker extractor is closed.');
    for (const task of queue.splice(0)) settle(task, { ok: false, error });
    closePromise = Promise.all(slots.map((slot) => retireSlot(slot, error, false))).then(() => undefined);
    return closePromise;
  }

  try {
    for (let index = 0; index < settings.poolSize; index++) createSlot();
  } catch (error) {
    closed = true;
    for (const slot of slots) {
      if (slot.startupTimer !== undefined) clearTimeout(slot.startupTimer);
      void workerTermination(slot.worker);
    }
    throw error;
  }

  return { extract, close };
}

/**
 * The built worker thread entry next to this bundle: `worker-thread.js` for ESM, `worker-thread.cjs`
 * for CommonJS (tsdown provides `import.meta.url` in both).
 */
function builtWorkerEntry(): URL {
  const extension = import.meta.url.endsWith('.cjs') ? 'cjs' : 'js';
  return new URL(`./worker-thread.${extension}`, import.meta.url);
}

/** Create an isolated worker-backed extractor with a bounded queue and fixed-size pool. */
export function createExtractor(options: WorkerExtractorOptions = {}): WorkerExtractor {
  return makeWorkerExtractor(options, { workerEntry: builtWorkerEntry() });
}

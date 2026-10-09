import { AbortError } from './errors.js';
import type { Budget } from './budget.js';

/** Normalize supported web input sources into bytes while charging the shared input budget. */
export async function readInput(input: unknown, budget: Budget): Promise<Uint8Array> {
  budget.tick();

  if (input instanceof Uint8Array) {
    budget.addInputBytes(input.byteLength);
    return input;
  }

  if (input instanceof ArrayBuffer) {
    budget.addInputBytes(input.byteLength);
    return new Uint8Array(input);
  }

  if (ArrayBuffer.isView(input)) {
    budget.addInputBytes(input.byteLength);
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    budget.addInputBytes(input.size);
    const bytes = new Uint8Array(await input.arrayBuffer());
    budget.tick();
    return bytes;
  }

  if (isReadableStream(input)) {
    return readStream(input, budget);
  }

  throw new TypeError(
    'Unsupported input. Expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, or ReadableStream<Uint8Array>.',
  );
}

function isReadableStream(input: unknown): input is ReadableStream<Uint8Array> {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as { getReader?: unknown }).getReader === 'function'
  );
}

async function readStream(stream: ReadableStream<Uint8Array>, budget: Budget): Promise<Uint8Array> {
  const reader = stream.getReader();
  const signal = budget.signal;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let completed = false;
  let cancellationRequested = false;
  let rejectAbort: ((reason: AbortError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });

  const cancel = (reason?: unknown): void => {
    if (cancellationRequested) return;
    cancellationRequested = true;
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // The stream may already be errored or released; preserve the original failure.
    }
  };

  const onAbort = (): void => {
    const error = new AbortError({ cause: signal?.reason });
    rejectAbort?.(error);
    cancel(signal?.reason);
  };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    while (true) {
      budget.tick();
      const result = await Promise.race([reader.read(), aborted]);
      if (result.done) {
        completed = true;
        break;
      }
      if (!(result.value instanceof Uint8Array)) {
        throw new TypeError('ReadableStream input must yield Uint8Array chunks.');
      }
      budget.addInputBytes(result.value.byteLength);
      total += result.value.byteLength;
      chunks.push(new Uint8Array(result.value));
    }
  } catch (error) {
    cancel(signal?.aborted ? signal.reason : undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!completed) cancel(signal?.aborted ? signal.reason : undefined);
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    budget.tick();
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

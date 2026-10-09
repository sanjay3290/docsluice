import { AbortError } from './errors.js';
import type { Budget } from './budget.js';

/** A single-use view over input bytes, split after a bounded detection prefix. */
export interface StreamInput {
  /** Bytes already read for format detection. They are also the first bytes yielded by `chunks()`. */
  readonly prefix: Uint8Array;
  /** Number of bytes pulled from this source so far, including the detection prefix. */
  readonly bytesRead: number;
  /** Yield the complete input in order. The prefix is yielded once and is not charged twice. */
  chunks(): AsyncIterable<Uint8Array>;
  /** Materialize the remaining input after the prefix. */
  collect(): Promise<Uint8Array>;
  /** Cancel an unconsumed remainder and release its source reader lock. */
  cancel(reason?: unknown): void;
}

const isReadableStream = (input: unknown): input is ReadableStream<Uint8Array> =>
  typeof input === 'object' &&
  input !== null &&
  typeof (input as { getReader?: unknown }).getReader === 'function';

/**
 * Read only enough input to inspect a bounded prefix. Remaining bytes are charged as the reader
 * consumes them, so an incremental reader can stop without pulling the rest of the source.
 */
export async function createStreamInput(
  input: unknown,
  budget: Budget,
  prefixLimit: number,
): Promise<StreamInput> {
  budget.tick();
  let initial: Uint8Array | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

  if (input instanceof Uint8Array) initial = input;
  else if (input instanceof ArrayBuffer) initial = new Uint8Array(input);
  else if (ArrayBuffer.isView(input))
    initial = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else if (typeof Blob !== 'undefined' && input instanceof Blob) reader = input.stream().getReader();
  else if (isReadableStream(input)) reader = input.getReader();
  else
    throw new TypeError(
      'Unsupported input. Expected Uint8Array, ArrayBuffer, ArrayBufferView, Blob, or ReadableStream<Uint8Array>.',
    );

  const signal = budget.signal;
  const buffered: Uint8Array[] = [];
  let total = 0;
  let remainder: Uint8Array | undefined;
  let completed = reader === undefined;
  let cancelled = false;
  let released = false;
  let rejectAbort: ((error: AbortError) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  // Cancellation can race with cleanup after a consumer stops iterating, when no read is
  // currently awaiting this promise. Keep that rejection observed in both cases.
  void aborted.catch(() => undefined);

  const cancelSource = (reason?: unknown): void => {
    if (!reader || cancelled || completed) return;
    cancelled = true;
    try {
      void reader.cancel(reason).catch(() => undefined);
    } catch {
      // Preserve the read or abort error if the source is already closed.
    }
  };
  const release = (): void => {
    if (!reader || released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {
      // A source can release itself while cancellation is settling.
    }
  };
  const onAbort = (): void => {
    const error = new AbortError({ cause: signal?.reason });
    rejectAbort?.(error);
    cancelSource(signal?.reason);
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    if (initial !== undefined) {
      const end = Math.min(initial.byteLength, prefixLimit);
      if (end > 0) {
        const prefixChunk = initial.subarray(0, end);
        budget.addInputBytes(prefixChunk.byteLength);
        buffered.push(prefixChunk);
        total = prefixChunk.byteLength;
      }
      if (end < initial.byteLength) remainder = initial.subarray(end);
    } else {
      while (total < prefixLimit) {
        budget.tick();
        const result = await Promise.race([reader!.read(), aborted]);
        if (result.done) {
          completed = true;
          break;
        }
        if (!(result.value instanceof Uint8Array))
          throw new TypeError('ReadableStream input must yield Uint8Array chunks.');
        const remaining = prefixLimit - total;
        const prefixEnd = Math.min(result.value.byteLength, remaining);
        if (prefixEnd > 0) {
          const prefixChunk = result.value.subarray(0, prefixEnd);
          budget.addInputBytes(prefixChunk.byteLength);
          buffered.push(prefixChunk);
          total += prefixChunk.byteLength;
        }
        if (prefixEnd < result.value.byteLength) remainder = result.value.subarray(prefixEnd);
        if (result.value.byteLength === 0) continue;
        if (remainder !== undefined) break;
      }
    }
  } catch (error) {
    cancelSource(signal?.aborted ? signal.reason : undefined);
    signal?.removeEventListener('abort', onAbort);
    release();
    throw error;
  }

  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of buffered) {
    budget.tick();
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let claimed = false;
  let chargedTotal = total;
  const chunks = async function* (): AsyncGenerator<Uint8Array> {
    if (claimed) throw new TypeError('An input stream can only be consumed once.');
    claimed = true;
    let finished = completed;
    try {
      if (prefix.byteLength > 0) yield prefix;
      if (remainder !== undefined) {
        budget.tick();
        budget.addInputBytes(remainder.byteLength);
        chargedTotal += remainder.byteLength;
        yield remainder;
        remainder = undefined;
      }
      while (reader && !finished) {
        budget.tick();
        const result = await Promise.race([reader.read(), aborted]);
        if (result.done) {
          finished = true;
          completed = true;
          break;
        }
        if (!(result.value instanceof Uint8Array))
          throw new TypeError('ReadableStream input must yield Uint8Array chunks.');
        budget.addInputBytes(result.value.byteLength);
        chargedTotal += result.value.byteLength;
        if (result.value.byteLength > 0) yield result.value;
      }
    } catch (error) {
      cancelSource(signal?.aborted ? signal.reason : undefined);
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (!finished) cancelSource(signal?.aborted ? signal.reason : undefined);
      release();
    }
  };

  return {
    prefix,
    get bytesRead() {
      return chargedTotal;
    },
    chunks,
    cancel(reason?: unknown): void {
      signal?.removeEventListener('abort', onAbort);
      cancelSource(reason);
      release();
    },
    async collect(): Promise<Uint8Array> {
      const chunksList: Uint8Array[] = [];
      let length = 0;
      for await (const chunk of chunks()) {
        budget.tick();
        chunksList.push(chunk);
        length += chunk.byteLength;
      }
      const result = new Uint8Array(length);
      let position = 0;
      for (const chunk of chunksList) {
        budget.tick();
        result.set(chunk, position);
        position += chunk.byteLength;
      }
      return result;
    },
  };
}

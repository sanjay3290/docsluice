/// <reference types="node" />

import { getHeapStatistics } from 'node:v8';
import { parentPort } from 'node:worker_threads';
import {
  DocsluiceError,
  EncryptedError,
  LimitExceededError,
  StrictModeError,
  TimeoutError,
  UnsupportedFormatError,
} from '../../core/errors.js';
import { extract } from '../../core/extract.js';
import type { ExtractOptions } from '../../core/options.js';

interface RequestMessage {
  id: number;
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
  options: ExtractOptions;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof DocsluiceError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error instanceof LimitExceededError ? { limit: error.limit, value: error.value } : {}),
      ...(error instanceof UnsupportedFormatError ? { format: error.format } : {}),
      ...(error instanceof EncryptedError ? { reason: error.reason } : {}),
      ...(error instanceof TimeoutError ? { timeMs: error.timeMs } : {}),
      ...(error instanceof StrictModeError ? { warningCode: error.warningCode } : {}),
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: 'Error', message: 'Extraction failed.' };
}

const port = parentPort;
if (!port) throw new Error('The docsluice worker entry must run inside a Node Worker.');

port.on('message', (request: RequestMessage) => {
  void (async () => {
    try {
      const input = new Uint8Array(request.buffer, request.byteOffset, request.byteLength);
      const result = await extract(input, request.options);
      port.postMessage({ id: request.id, ok: true, result });
    } catch (error) {
      port.postMessage({ id: request.id, ok: false, error: serializeError(error) });
    }
  })();
});

// The pool checks the heap limit V8 actually applied: a process-wide --max-old-space-size flag
// (command line or NODE_OPTIONS) overrides the Worker resourceLimits.
port.postMessage({ type: 'ready', heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20) });

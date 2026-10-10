import { getHeapStatistics } from 'node:v8';
import { TextDecoder } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';
import { readTestInput } from './worker-fixture-reader.mjs';

if (workerData.mode === 'hang-before-ready') {
  while (true) {
    // The worker-pool tests use this test-only entry mode to exercise startup termination.
  }
}

parentPort.on('message', ({ id, buffer, byteOffset, byteLength }) => {
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  // Reply modes for the pool's error handling: a serialized error read from the input, a message
  // that is not a response, and a response to another request.
  if (workerData.mode === 'errors') {
    const error = JSON.parse(new TextDecoder().decode(bytes));
    parentPort.postMessage(error === null ? { id, ok: false } : { id, ok: false, error });
    return;
  }
  if (workerData.mode === 'garbage') {
    parentPort.postMessage('not a response');
    return;
  }
  if (workerData.mode === 'wrong-id') {
    parentPort.postMessage({ id: id + 1_000, ok: true, result: {} });
    return;
  }
  parentPort.postMessage({ id, ok: true, result: readTestInput(workerData.mode, bytes) });
});

parentPort.postMessage({
  type: 'ready',
  heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20),
});

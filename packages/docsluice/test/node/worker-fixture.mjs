import { getHeapStatistics } from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';
import { readTestInput } from './worker-fixture-reader.mjs';

if (workerData.mode === 'hang-before-ready') {
  while (true) {
    // The worker-pool tests use this test-only entry mode to exercise startup termination.
  }
}

parentPort.on('message', ({ id, buffer, byteOffset, byteLength }) => {
  const bytes = new Uint8Array(buffer, byteOffset, byteLength);
  parentPort.postMessage({ id, ok: true, result: readTestInput(workerData.mode, bytes) });
});

parentPort.postMessage({ type: 'ready', heapLimitMb: Math.round(getHeapStatistics().heap_size_limit / 2 ** 20) });

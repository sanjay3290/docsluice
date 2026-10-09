# Worker-backed extraction

`docsluice/worker` runs the normal extractor in a Node `worker_threads` pool. It is intended for services that need a parser crash, runaway parser, or worker heap exhaustion to stay outside the caller's JavaScript thread.

```ts
import { createExtractor } from 'docsluice/worker';

const isolated = createExtractor({
  maxOldGenerationSizeMb: 256,
  timeMs: 30_000,
  poolSize: 2,
});

try {
  const document = await isolated.extract(new Uint8Array(await file.arrayBuffer()));
  // Use the structured-cloned document.
} finally {
  await isolated.close();
}
```

All three settings are optional. Defaults are 256 MiB for each worker's V8 old-generation heap, 60 seconds per active extraction, and one worker. `poolSize` must be an integer from 1 to 32. A fixed queue accepts up to 1,024 pending jobs; further calls reject with `LimitExceededError` using the `workerQueue` limit name. Queue wait is outside the per-job timeout. A worker must announce readiness within 30 seconds of starting; a startup stall times out queued jobs and closes the pool.

Node transfers an owned `ArrayBuffer` to the worker without copying it. This detaches that buffer and every view sharing it on the caller's side once the job is dispatched. `Buffer` inputs are copied into owned byte arrays before transfer because a `Buffer` can share pooled storage; inputs marked untransferable are copied as a fallback. `Blob` and stream inputs are read into bounded bytes before dispatch. Keep a transferred buffer only if the caller is ready to give up access to it. The worker returns a structured-cloned document.

`transform` and `onBlock` are function callbacks and cannot cross the worker boundary, so worker extraction rejects either option with `TypeError` before it reads or transfers input. `signal` remains supported: aborting a queued job removes it from the queue; aborting a running job terminates and replaces its worker, then rejects with `AbortError`. Calling `close()` rejects pending work, terminates the pool, and makes later `extract()` calls reject.

The parent maps a worker timeout to `TimeoutError` and an unexpected worker exit, including V8 worker heap exhaustion, to `LimitExceededError` with `limit: "memory"`. `maxOldGenerationSizeMb` limits V8's JavaScript heap only. It does not cap total RSS or external allocations such as `ArrayBuffer` memory, and a process-wide out-of-memory condition can still terminate Node. To keep the requested old-generation cap effective, the pool filters inherited `--max-old-space-size` flags while preserving other Node flags, including permission flags. See the [Node.js v24 Worker documentation](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#worker-constructor-options) for the exact `resourceLimits` boundary and [transfer-list behavior](https://nodejs.org/docs/latest-v24.x/api/worker_threads.html#portpostmessagevalue-transferlist).

Run the worker tests with:

```sh
npm test -- --run test/node/worker.test.ts
```

The OOM, timeout, and pool tests use a test-only `.mjs` worker fixture and reader. They are not included in the package and do not accept document data as code.

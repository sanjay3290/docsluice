import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_WORKERS_RESPONSE_BYTES,
  createWranglerStateDirectory,
  readBoundedResponse,
  startWrangler,
  stopWrangler,
} from '../run-workers-runtime.mjs';

test('Wrangler spawn failures reject with a readable dependency error', async () => {
  await assert.rejects(
    startWrangler(path.join(os.tmpdir(), `missing-wrangler-${process.pid}`), [], { stdio: 'ignore' }),
    /Could not start Wrangler.*ENOENT/i,
  );
});

test('each Wrangler run receives a unique temporary state directory', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'docsluice-runtime-state-test-'));
  try {
    const first = await createWranglerStateDirectory(parent);
    const second = await createWranglerStateDirectory(parent);
    assert.notEqual(first, second);
    await Promise.all([rm(first, { recursive: true }), rm(second, { recursive: true })]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test('stop waits for exit after escalating from TERM to KILL', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'],
    { detached: process.platform !== 'win32', stdio: 'ignore' },
  );
  await once(child, 'spawn');
  await delay(100);
  try {
    await stopWrangler(child, { termGraceMs: 25, killGraceMs: 1_000 });
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

test('response body reader returns small bodies and rejects oversized bodies', async () => {
  const small = new globalThis.Response('small body');
  assert.equal(await readBoundedResponse(small), 'small body');

  let canceled = false;
  const large = new globalThis.Response(
    new globalThis.ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_WORKERS_RESPONSE_BYTES + 1));
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  await assert.rejects(readBoundedResponse(large), /exceeds 65536 bytes/i);
  assert.equal(canceled, true);
});

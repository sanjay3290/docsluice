import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { URL } from 'node:url';
import { checkUnhandledRejections } from '../hostile/unhandled-rejections.mjs';

test('the hostile rejection guard fails on an unused rejected promise', () => {
  const helper = new URL('../hostile/unhandled-rejections.mjs', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { checkUnhandledRejections } from ${JSON.stringify(helper)};
    await checkUnhandledRejections(async () => { Promise.reject(new Error('private input')); });
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Hostile extraction caused 1 unhandled rejection/);
  assert.doesNotMatch(result.stderr, /private input/);
});

test('the hostile rejection guard preserves outcomes and removes its listener', async () => {
  const before = process.listenerCount('unhandledRejection');
  assert.equal(await checkUnhandledRejections(async () => 'result'), 'result');
  const error = new Error('ordinary parser failure');
  await assert.rejects(
    checkUnhandledRejections(async () => {
      throw error;
    }),
    error,
  );
  assert.equal(process.listenerCount('unhandledRejection'), before);
});

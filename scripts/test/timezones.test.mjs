import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// DET-1: date and number formatting must not depend on the host time zone. The number-format
// tests and the reviewed goldens run in child processes at the earliest and a late UTC offset.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../packages/docsluice');
const vitest = path.resolve(packageRoot, '../../node_modules/vitest/vitest.mjs');

for (const zone of ['Pacific/Kiritimati', 'America/Los_Angeles']) {
  test(`number formats and goldens are unchanged with TZ=${zone}`, () => {
    const result = spawnSync(
      process.execPath,
      [vitest, 'run', 'test/xlsx/numfmt.test.ts', 'test/golden.test.ts'],
      { cwd: packageRoot, env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `vitest failed with TZ=${zone}:\n${result.stdout}\n${result.stderr}`);
    // The child really ran in the requested zone.
    const offset = spawnSync(process.execPath, ['-e', 'console.log(new Date(0).getTimezoneOffset())'], {
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
    });
    assert.notEqual(offset.stdout.trim(), '0');
  });
}

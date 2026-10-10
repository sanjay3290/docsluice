import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { withBufferAccessTrap } from './buffer-trap.mjs';

test('Buffer trap rejects access while dynamically importing a module', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  if (prior) Reflect.deleteProperty(globalThis, 'Buffer');
  const fixturePath = fileURLToPath(new globalThis.URL('./buffer-access-fixture.mjs', import.meta.url));
  try {
    await assert.rejects(
      withBufferAccessTrap(() => import(pathToFileURL(fixturePath).href)),
      /global Buffer access trap/i,
    );
    assert.equal(Object.hasOwn(globalThis, 'Buffer'), false, 'trap should be removed after rejection');
  } finally {
    if (prior) Object.defineProperty(globalThis, 'Buffer', prior);
  }
});

test('intentional Buffer fixture really reads the global', async () => {
  const source = await readFile(new globalThis.URL('./buffer-access-fixture.mjs', import.meta.url), 'utf8');
  assert.match(source, /globalThis\.Buffer/);
});

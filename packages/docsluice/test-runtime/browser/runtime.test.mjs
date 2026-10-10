import { expect, test } from 'vitest';
import { withBrowserBufferAccessTrap } from './buffer-trap.mjs';

test('built package works in real browsers without accessing global Buffer', async () => {
  await withBrowserBufferAccessTrap(async () => {
    const [{ runRuntimeContract }, { loadRuntimeFixtures }] = await Promise.all([
      import('../cases.mjs'),
      import('../fixtures.generated.mjs'),
    ]);
    await runRuntimeContract(loadRuntimeFixtures());
  });
});

test('browser Buffer trap rejects a deliberate Buffer access during dynamic import', async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
  await expect(
    withBrowserBufferAccessTrap(() => import('../workers/buffer-access-fixture.mjs')),
  ).rejects.toThrow(/global Buffer access trap/i);
  expect(Object.getOwnPropertyDescriptor(globalThis, 'Buffer')).toEqual(prior);
});

test('browser Buffer trap restores an existing global after failure', async () => {
  const target = { Buffer: 'sentinel' };
  const prior = Object.getOwnPropertyDescriptor(target, 'Buffer');
  await expect(withBrowserBufferAccessTrap(() => target.Buffer, target)).rejects.toThrow(
    /global Buffer access trap/i,
  );
  expect(Object.getOwnPropertyDescriptor(target, 'Buffer')).toEqual(prior);
});

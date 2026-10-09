import { test } from 'vitest';
import { runRuntimeContract } from '../cases.mjs';
import { loadRuntimeFixtures } from '../fixtures.generated.mjs';

test('built package works in real browsers', async () => {
  await runRuntimeContract(loadRuntimeFixtures());
});

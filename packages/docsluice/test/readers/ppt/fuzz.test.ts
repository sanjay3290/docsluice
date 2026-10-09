import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fuzzPpt } from '../../../fuzz/ppt.fuzz.js';

describe('PPT fuzz target', () => {
  it('handles a valid deck and deterministic truncation/corruption samples', async () => {
    const valid = new Uint8Array(
      readFileSync(new URL('../../../../../corpus/ppt/order-title-notes.ppt', import.meta.url)),
    );
    await expect(fuzzPpt(valid)).resolves.toBeUndefined();
    for (const size of [0, 8, 128, 511, 512, 1000, valid.length - 1])
      await expect(fuzzPpt(valid.subarray(0, size))).resolves.toBeUndefined();
    for (const offset of [0, 26, 30, 44, 48, 68]) {
      const changed = valid.slice();
      changed[offset] = 0xff;
      await expect(fuzzPpt(changed)).resolves.toBeUndefined();
    }
  });
});

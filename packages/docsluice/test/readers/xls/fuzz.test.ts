import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fuzzXls } from '../../../fuzz/xls.fuzz.js';

describe('XLS fuzz target smoke checks', () => {
  it('accepts a valid BIFF8 workbook and expected malformed inputs', async () => {
    const source = new Uint8Array(
      readFileSync(fileURLToPath(new URL('./fixtures/biff8-source.xls', import.meta.url))),
    );
    await expect(fuzzXls(source)).resolves.toBeUndefined();
    await expect(fuzzXls(Uint8Array.of(0x01, 0x02, 0x03))).resolves.toBeUndefined();
  });
});

import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { Cell } from '../../../src/core/model.js';
import { Budget } from '../../../src/core/budget.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { readDelimitedStream } from '../../../src/readers/csv/index.js';

describe.skipIf(process.env.DOCSLUICE_SLOW !== '1')('slow CSV stream acceptance benchmark', () => {
  it('processes generated 1 GiB CSV through bounded batches and a discard sink', async () => {
    const totalBytes = 1_073_741_824;
    const sourceChunk = new Uint8Array(65_536);
    for (let index = 0; index < sourceChunk.length; index += 4) {
      sourceChunk[index] = 97;
      sourceChunk[index + 1] = 44;
      sourceChunk[index + 2] = 98;
      sourceChunk[index + 3] = 10;
    }

    const warnings = new WarningSink();
    const budget = new Budget(
      resolveLimits({ cells: 600_000_000, outputChars: 600_000_000, timeMs: 120_000 }),
      { warnings },
    );
    let emittedRows = 0;
    let emittedTables = 0;
    let sampledMaxHeap = 0;
    const sampleHeap = (): void => {
      sampledMaxHeap = Math.max(sampledMaxHeap, process.memoryUsage().heapUsed);
    };
    const out = {
      setEncoding(): void {},
      table(rows: Cell[][]): boolean {
        emittedTables += 1;
        emittedRows += rows.length;
        let chars = 0;
        for (const row of rows) for (const cell of row) chars += cell.text.length;
        if (!budget.addOutputChars(chars)) return false;
        sampleHeap();
        return true;
      },
    };
    const input = {
      prefix: sourceChunk.subarray(0, 8_192),
      async *chunks(): AsyncGenerator<Uint8Array> {
        await Promise.resolve();
        for (let offset = 0; offset < totalBytes; offset += sourceChunk.length) yield sourceChunk;
      },
    };
    const startedAt = performance.now();
    const rows = await readDelimitedStream({ budget, warnings, path: '', out }, input, async () => {
      sampleHeap();
      await Promise.resolve();
    });
    const elapsedMs = performance.now() - startedAt;

    expect(rows).toBe(totalBytes / 4);
    expect(emittedRows).toBe(rows);
    expect(emittedTables).toBe(Math.ceil(rows / 1_000));
    expect(sampledMaxHeap).toBeLessThan(200 * 1024 * 1024);
    process.stdout.write(
      `CSV stream 1 GiB: ${elapsedMs.toFixed(1)} ms; sampled max heap ${Math.round(sampledMaxHeap / 1024 / 1024)} MiB; ${emittedTables} tables.\n`,
    );
  }, 120_000);
});

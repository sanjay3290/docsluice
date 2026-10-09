import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { gzipSync } from 'fflate';
import { reader } from '../../../src/readers/gzip/index.js';
import { reader as tarReader } from '../../../src/readers/tar/index.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../../corpus/tar/${name}`, import.meta.url)));
}

function makeContext(
  bytes: Uint8Array,
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
  children: 'extract' | 'list' | 'skip' = 'extract',
  filename?: string,
  signal?: AbortSignal,
) {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...overrides }, { onLimit: 'throw', signal });
  const warnings = new WarningSink();
  const options = { children, childBytes: false, metadata: true, runs: false } as ReadContext['options'];
  const out = new DocBuilder('gzip', 'application/gzip', budget, options);
  const extracted: Array<{ name: string; bytes: Uint8Array }> = [];
  const ctx: ReadContext = {
    bytes,
    filename,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild(name, childBytes) {
      extracted.push({ name, bytes: childBytes });
      return Promise.resolve();
    },
  };
  return { ctx, out, budget, extracted, warnings };
}

function makeTarContext(bytes: Uint8Array) {
  const budget = new Budget({ ...DEFAULT_LIMITS }, { onLimit: 'throw' });
  const warnings = new WarningSink();
  const options = {
    children: 'extract',
    childBytes: false,
    metadata: true,
    runs: false,
  } as ReadContext['options'];
  const out = new DocBuilder('tar', 'application/x-tar', budget, options);
  const extracted: Array<{ name: string; bytes: Uint8Array }> = [];
  const ctx: ReadContext = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild(name, childBytes) {
      extracted.push({ name, bytes: childBytes });
      return Promise.resolve();
    },
  };
  return { ctx, extracted };
}

describe('gzip reader', () => {
  it('detects gzip magic and supports empty output', async () => {
    expect(reader.detect?.(new Uint8Array([0x1f, 0x8b]))).toBe(1);
    expect(reader.detect?.(new Uint8Array([0x00, 0x00]))).toBe(0);
    const empty = makeContext(gzipSync(new Uint8Array()));
    await reader.read(empty.ctx);
    expect(empty.extracted[0]?.bytes).toEqual(new Uint8Array());
  });

  it('inflates a CSV to one child', async () => {
    const { ctx, out, extracted, budget } = makeContext(fixture('gzip-csv.gz'), {}, 'extract', 'gzip-csv.gz');
    await reader.read(ctx);
    expect(extracted).toHaveLength(1);
    expect(new TextDecoder().decode(extracted[0]!.bytes)).toContain('id,total');
    expect(extracted[0]!.name).toBe('gzip-csv');
    expect(budget.totalUncompressedBytes).toBe(extracted[0]!.bytes.length);
    expect(out.finish().children).toHaveLength(0);
  });

  it('composes with TAR for a .tar.gz child', async () => {
    const gzip = makeContext(fixture('tar-gzip.tar.gz'));
    await reader.read(gzip.ctx);
    expect(gzip.extracted).toHaveLength(1);
    const tar = makeTarContext(gzip.extracted[0]!.bytes);
    await tarReader.read(tar.ctx);
    expect(tar.extracted.map((entry) => entry.name)).toContain('folder/subfolder/data.csv');
    expect(new TextDecoder().decode(tar.extracted[0]!.bytes)).toContain('k,v');
  });

  it('supports concatenated members and optional gzip header fields', async () => {
    for (const filename of ['gzip-multi-member.gz', 'gzip-optional-header.gz']) {
      const { ctx, extracted } = makeContext(fixture(filename));
      await reader.read(ctx);
      expect(extracted).toHaveLength(1);
      expect(extracted[0]!.bytes.length).toBeGreaterThan(0);
    }
    const multi = makeContext(fixture('gzip-multi-member.gz'));
    await reader.read(multi.ctx);
    expect(multi.budget.entries).toBe(2);
  });

  it('bounds an oversized FNAME while scanning through its terminator', async () => {
    const compressed = fixture('gzip-csv.gz');
    const name = new Uint8Array(16_385).fill(0x61);
    const bytes = new Uint8Array(compressed.length + name.length);
    bytes.set(compressed.subarray(0, 10), 0);
    bytes[3] = bytes[3]! | 0x08;
    bytes.set(name, 10);
    bytes[10 + name.length - 1] = 0;
    bytes.set(compressed.subarray(10), 10 + name.length);
    const { ctx, extracted, warnings } = makeContext(bytes);
    await reader.read(ctx);
    expect(extracted[0]?.name).toBe('content');
    expect(warnings.warnings.some((warning) => warning.code === 'UNREADABLE_PART')).toBe(true);
  });

  it('validates the second member header before inflating it', async () => {
    const bytes = fixture('gzip-multi-member.gz');
    let second = -1;
    for (let index = 1; index + 2 < bytes.length; index++) {
      if (bytes[index] === 0x1f && bytes[index + 1] === 0x8b && bytes[index + 2] === 8) second = index;
    }
    expect(second).toBeGreaterThan(0);
    bytes[second + 3] = bytes[second + 3]! | 0x20;
    await expect(reader.read(makeContext(bytes).ctx)).rejects.toBeDefined();
  });

  it('does not inflate in list mode', async () => {
    const { ctx, out, budget, extracted } = makeContext(fixture('gzip-csv.gz'), {}, 'list');
    await reader.read(ctx);
    expect(extracted).toEqual([]);
    expect(budget.totalUncompressedBytes).toBe(0);
    expect(out.finish().children[0]?.status).toBe('listed');
  });

  it('does not inflate in skip mode and sanitizes filename paths', async () => {
    const skipped = makeContext(fixture('gzip-csv.gz'), {}, 'skip');
    await reader.read(skipped.ctx);
    expect(skipped.extracted).toEqual([]);
    const named = makeContext(fixture('gzip-csv.gz'), {}, 'extract', 'C:\\..\\tmp\\sheet.csv.gz');
    await reader.read(named.ctx);
    expect(named.extracted[0]?.name).toBe('tmp/sheet.csv');
  });

  it('stops on the shared uncompressed byte limit', async () => {
    const { ctx } = makeContext(fixture('gzip-bounded-amplification.gz'), { totalUncompressedBytes: 64 });
    await expect(reader.read(ctx)).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('enforces compression ratio and propagates cancellation', async () => {
    const ratio = makeContext(fixture('gzip-bounded-amplification.gz'), {
      compressionRatio: 2,
      compressionRatioMinBytes: 0,
    });
    await expect(reader.read(ratio.ctx)).rejects.toBeInstanceOf(LimitExceededError);
    const controller = new AbortController();
    controller.abort();
    const cancelled = makeContext(fixture('gzip-csv.gz'), {}, 'extract', undefined, controller.signal);
    await expect(reader.read(cancelled.ctx)).rejects.toHaveProperty('code', 'ABORTED');
  });

  it('verifies member CRC and rejects a damaged trailer', async () => {
    const bytes = fixture('gzip-csv.gz');
    bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 0xff;
    await expect(reader.read(makeContext(bytes).ctx)).rejects.toBeDefined();
  });

  it('validates FHCRC instead of relying on inflater behavior', async () => {
    const bytes = fixture('gzip-optional-header.gz');
    const flags = bytes[3]!;
    let cursor = 10;
    if (flags & 4) cursor += 2 + bytes[cursor]! + (bytes[cursor + 1]! << 8);
    if (flags & 8)
      while (bytes[cursor++] !== 0) {
        /* bounded synthetic fixture header */
      }
    if (flags & 16)
      while (bytes[cursor++] !== 0) {
        /* bounded synthetic fixture header */
      }
    expect(flags & 2).toBe(2);
    bytes[cursor] = bytes[cursor]! ^ 0xff;
    await expect(reader.read(makeContext(bytes).ctx)).rejects.toBeDefined();
  });

  it('rejects malformed gzip input without swallowing budget errors', async () => {
    const bytes = fixture('gzip-csv.gz');
    bytes[0] = 0;
    const { ctx } = makeContext(bytes);
    await expect(reader.read(ctx)).rejects.toBeDefined();
  });
});

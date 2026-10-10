import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { AbortError, CorruptFileError, LimitExceededError, StrictModeError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { makeZip } from '../helpers/zip.js';
import { openZip } from '../../src/zip/index.js';

function budget(overrides: Partial<typeof DEFAULT_LIMITS> = {}, onLimit: 'truncate' | 'throw' = 'throw') {
  return new Budget({ ...DEFAULT_LIMITS, ...overrides }, { onLimit });
}

describe('openZip', () => {
  it.each(['hello.odt', 'zip-cli.zip'])('reads real producer archive %s', async (fixture) => {
    const bytes = new Uint8Array(readFileSync(new URL(`../../../../corpus/zip/${fixture}`, import.meta.url)));
    const sharedBudget = budget();
    const archive = openZip(bytes, sharedBudget);
    expect(archive.entries.length).toBeGreaterThan(0);
    expect(archive.entries.every((entry) => !entry.isUnreadable)).toBe(true);
    const contents = await Promise.all(archive.entries.map((entry) => archive.read(entry)));
    expect(contents.every((content) => content !== null)).toBe(true);
    expect(sharedBudget.totalUncompressedBytes).toBeGreaterThan(0);
  });

  it('has no Node or filesystem imports in the shipped reader', () => {
    const source = readFileSync(new URL('../../src/zip/index.ts', import.meta.url), 'utf8');
    expect(
      source.includes("from 'node:") ||
        source.includes('from "node:') ||
        source.includes("from 'fs") ||
        source.includes('from "fs'),
    ).toBe(false);
  });

  it('reads stored and deflated entries in central-directory order and counts output bytes', async () => {
    const bytes = makeZip([
      { name: 'second.txt', data: new TextEncoder().encode('second') },
      { name: 'first.txt', data: new TextEncoder().encode('first'), method: 8 },
    ]);
    const sharedBudget = budget();
    const archive = openZip(bytes, sharedBudget);

    expect(archive.entries.map((entry) => entry.name)).toEqual(['second.txt', 'first.txt']);
    expect(await archive.read(archive.entries[0]!)).toEqual(new TextEncoder().encode('second'));
    expect(await archive.read(archive.entries[1]!)).toEqual(new TextEncoder().encode('first'));
    expect(sharedBudget.totalUncompressedBytes).toBe(11);
  });

  it('reads a 1 MiB incompressible DEFLATE member within the ZIP throughput guard', async () => {
    const data = new Uint8Array(1024 * 1024);
    let state = 0x12345678;
    for (let index = 0; index < data.length; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      data[index] = state & 0xff;
    }
    const archive = openZip(makeZip([{ name: 'random.bin', data, method: 8 }]), budget());
    const started = performance.now();
    const output = await archive.read(archive.entries[0]!);
    const elapsed = performance.now() - started;
    expect(output).toEqual(data);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('reads entries with signed and unsigned data descriptors', async () => {
    const archive = openZip(
      makeZip([
        { name: 'signed', data: new TextEncoder().encode('signed descriptor'), dataDescriptor: true },
        {
          name: 'unsigned',
          data: new TextEncoder().encode('unsigned descriptor'),
          dataDescriptor: true,
          descriptorSignature: false,
          method: 8,
        },
      ]),
      budget(),
    );
    expect(archive.entries.every((entry) => !entry.isUnreadable)).toBe(true);
    expect(await archive.read(archive.entries[0]!)).toEqual(new TextEncoder().encode('signed descriptor'));
    expect(await archive.read(archive.entries[1]!)).toEqual(new TextEncoder().encode('unsigned descriptor'));
  });

  it('rejects a data descriptor that disagrees with the directory', () => {
    const bytes = makeZip([
      { name: 'bad', data: new Uint8Array([1]), dataDescriptor: true, descriptorSignature: false },
    ]);
    new DataView(bytes.buffer).setUint32(34, 0, true);
    expect(openZip(bytes, budget()).entries[0]?.isUnreadable).toBe(true);
  });

  it('reads ZIP64 end records', async () => {
    const archive = openZip(
      makeZip([{ name: 'zip64.txt', data: new Uint8Array([1, 2, 3]) }], { zip64: true }),
      budget(),
    );
    expect(archive.entries).toHaveLength(1);
    expect(await archive.read(archive.entries[0]!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('handles the hostile ZIP64 million-entry count before parsing a directory', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/many-entries.zip', import.meta.url)),
    );
    expect(() => openZip(bytes, budget({ zipEntries: 10 }))).toThrow(LimitExceededError);
    const partial = openZip(bytes, budget({ zipEntries: 10 }, 'truncate'));
    expect(partial.entries).toEqual([]);
  });

  it('runs checked-in hostile ZIP recipes through the reader', async () => {
    const bombBytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/bomb-42k.zip', import.meta.url)),
    );
    const bombBudget = budget();
    const bomb = openZip(bombBytes, bombBudget);
    expect(bomb.entries[0]?.compressedSize).toBeGreaterThan(40 * 1024);
    expect(bomb.entries[0]?.compressedSize).toBeLessThan(45 * 1024);
    await expect(bomb.read(bomb.entries[0]!)).rejects.toBeInstanceOf(LimitExceededError);

    const traversalBytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/path-traversal.zip', import.meta.url)),
    );
    expect(openZip(traversalBytes, budget()).entries[0]?.name).toBe('etc/passwd');

    const overlapBytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/overlap.zip', import.meta.url)),
    );
    const overlap = openZip(overlapBytes, budget());
    expect(overlap.entries.every((entry) => entry.isUnreadable)).toBe(true);
  });

  it('checks the declared entry count before parsing central-directory headers', () => {
    const bytes = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    const eocd = bytes.length - 22;
    new DataView(bytes.buffer).setUint16(eocd + 8, 1_000_000, true);
    new DataView(bytes.buffer).setUint16(eocd + 10, 1_000_000, true);
    bytes[30] = 0;
    expect(() => openZip(bytes, budget({ zipEntries: 5 }))).toThrow(LimitExceededError);
  });

  it('cleans traversal, drive, leading slash, and control characters in names', () => {
    const archive = openZip(
      makeZip([
        { name: '../../etc/passwd', data: new Uint8Array() },
        { name: 'C:\\x', data: new Uint8Array() },
        { name: '/root/\u0001note', data: new Uint8Array() },
      ]),
      budget(),
    );
    expect(archive.entries.map((entry) => entry.name)).toEqual(['etc/passwd', 'x', 'root/�note']);
  });

  it('decodes legacy names as CP437', () => {
    const bytes = makeZip([{ name: 'x', data: new Uint8Array() }]);
    const central = bytes.findIndex(
      (value, index) => value === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01,
    );
    bytes[6] = 0;
    bytes[7] = 0;
    bytes[central + 8] = 0;
    bytes[central + 9] = 0;
    bytes[30] = 0x82;
    bytes[central + 46] = 0x82;
    const archive = openZip(bytes, budget());
    expect(archive.entries[0]?.name).toBe('é');
  });

  it('lists encrypted and unsupported entries as unreadable', async () => {
    const warnings = new WarningSink();
    const archive = openZip(
      makeZip([
        { name: 'encrypted', data: new Uint8Array([1]), flags: 0x0801 },
        { name: 'bzip', data: new Uint8Array([2]), method: 12 },
      ]),
      new Budget(DEFAULT_LIMITS, { warnings }),
    );
    expect(archive.entries.map((entry) => [entry.isEncrypted, entry.isUnreadable])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(await archive.read(archive.entries[1]!)).toBeNull();
    expect(warnings.warnings).toHaveLength(2);
  });

  it('applies strict warning policy to unsupported entries', () => {
    const strictWarnings = new WarningSink({ strict: true });
    expect(() =>
      openZip(
        makeZip([{ name: 'unsupported', data: new Uint8Array(), method: 12 }]),
        new Budget(DEFAULT_LIMITS, { warnings: strictWarnings }),
      ),
    ).toThrow(StrictModeError);
  });

  it('marks overlapping local records unreadable', async () => {
    const bytes = makeZip([
      { name: 'same', data: new Uint8Array([1, 2, 3]) },
      { name: 'same', data: new Uint8Array([1, 2, 3]) },
    ]);
    const secondCentral =
      bytes.findIndex(
        (value, index) => value === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01,
      ) +
      46 +
      4;
    new DataView(bytes.buffer).setUint32(secondCentral + 42, 0, true);
    const warnings = new WarningSink();
    const archive = openZip(bytes, new Budget(DEFAULT_LIMITS, { warnings }));
    expect(archive.entries.every((entry) => entry.isUnreadable)).toBe(true);
    expect(warnings.warnings.some((warning) => warning.code === 'UNREADABLE_PART')).toBe(true);
    expect(await archive.read(archive.entries[0]!)).toBeNull();
  });

  it('stops a declared multi-gigabyte deflate bomb at the real ratio budget', async () => {
    const content = new Uint8Array(42 * 1024 * 1024);
    const bytes = makeZip([{ name: 'bomb', data: content, method: 8, declaredSize: 0x1_0000_0000 }], {
      zip64: true,
    });
    const limits = { ...DEFAULT_LIMITS, compressionRatioMinBytes: 1, compressionRatio: 100 };
    const sharedBudget = new Budget(limits, { onLimit: 'throw' });
    const archive = openZip(bytes, sharedBudget);
    expect(archive.entries[0]?.compressedSize).toBeGreaterThan(40 * 1024);
    expect(archive.entries[0]?.compressedSize).toBeLessThan(45 * 1024);
    expect(archive.entries[0]?.uncompressedSize).toBe(0x1_0000_0000);
    const started = performance.now();
    await expect(archive.read(archive.entries[0]!)).rejects.toBeInstanceOf(LimitExceededError);
    expect(sharedBudget.totalUncompressedBytes).toBeLessThanOrEqual(
      archive.entries[0]!.compressedSize * 100 + 64 * 1024,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('stops a real nested 4 GiB DEFLATE source through one shared budget', async () => {
    const fixture = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/nested-4gib.zip', import.meta.url)),
    );
    const ratio = 1_000;
    class RatioTrackingBudget extends Budget {
      watchRatio = false;
      lastRatioCheck: { compressed: number; uncompressed: number } | undefined;

      override checkRatio(compressed: number, uncompressed: number): boolean {
        if (this.watchRatio) this.lastRatioCheck = { compressed, uncompressed };
        return super.checkRatio(compressed, uncompressed);
      }
    }
    const sharedBudget = new RatioTrackingBudget(
      {
        ...DEFAULT_LIMITS,
        compressionRatio: ratio,
        compressionRatioMinBytes: 1024,
        totalUncompressedBytes: 16 * 1024 * 1024,
      },
      { onLimit: 'throw' },
    );
    const outer = openZip(fixture, sharedBudget);
    expect(outer.entries[0]?.compressionMethod).toBe(8);
    expect(outer.entries[0]?.uncompressedSize).toBeGreaterThan(4_000_000);
    const started = performance.now();
    const innerBytes = await outer.read(outer.entries[0]!);
    expect(innerBytes).not.toBeNull();
    expect(innerBytes!.length).toBe(outer.entries[0]?.uncompressedSize);
    const inner = openZip(innerBytes!, sharedBudget);
    expect(inner.entries[0]?.compressionMethod).toBe(8);
    expect(inner.entries[0]?.uncompressedSize).toBe(0x1_0000_0000);
    expect(sharedBudget.totalUncompressedBytes).toBe(innerBytes!.length);

    const beforeInnerRead = sharedBudget.totalUncompressedBytes;
    sharedBudget.watchRatio = true;
    await expect(inner.read(inner.entries[0]!)).rejects.toMatchObject({ limit: 'compressionRatio' });
    const elapsed = performance.now() - started;
    const check = sharedBudget.lastRatioCheck;
    expect(check).toBeDefined();
    expect(sharedBudget.totalUncompressedBytes - beforeInnerRead).toBeLessThanOrEqual(
      ratio * check!.compressed + 64 * 1024,
    );
    expect(sharedBudget.totalUncompressedBytes).toBeLessThan(16 * 1024 * 1024);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('returns null and counts actual output when the shared byte budget truncates', async () => {
    const sharedBudget = budget({ totalUncompressedBytes: 2 }, 'truncate');
    const archive = openZip(makeZip([{ name: 'limited', data: new Uint8Array([1, 2, 3, 4]) }]), sharedBudget);
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(sharedBudget.totalUncompressedBytes).toBe(4);
    expect(sharedBudget.truncated).toBe(true);
  });

  it('reads a large stored entry in bounded chunks and stops near the output limit', async () => {
    const content = new Uint8Array(5 * 1024 * 1024);
    const sharedBudget = budget({ totalUncompressedBytes: 32 * 1024 }, 'truncate');
    const archive = openZip(makeZip([{ name: 'stored-large', data: content }]), sharedBudget);

    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(sharedBudget.totalUncompressedBytes).toBeGreaterThanOrEqual(32 * 1024);
    expect(sharedBudget.totalUncompressedBytes).toBeLessThanOrEqual(48 * 1024);
    expect(sharedBudget.totalUncompressedBytes).toBeLessThan(content.length);
    expect(sharedBudget.truncated).toBe(true);
  });

  it('grows DEFLATE input slices for large entries while keeping each push within the overshoot bounds', async () => {
    // Text-like data that compresses about 5:1, like worksheet XML.
    const content = new Uint8Array(4 * 1024 * 1024);
    let seed = 7;
    for (let index = 0; index < content.length; index++) {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      content[index] = 97 + ((seed >>> 16) % 8);
    }
    const checks: Array<{ compressed: number; uncompressed: number }> = [];
    class CountingBudget extends Budget {
      override checkRatio(compressed: number, uncompressed: number): boolean {
        checks.push({ compressed, uncompressed });
        return super.checkRatio(compressed, uncompressed);
      }
    }
    const sharedBudget = new CountingBudget(DEFAULT_LIMITS, { onLimit: 'throw' });
    const archive = openZip(makeZip([{ name: 'large', data: content, method: 8 }]), sharedBudget);
    const compressedSize = archive.entries[0]!.compressedSize;
    const output = await archive.read(archive.entries[0]!);
    expect(output?.length).toBe(content.length);
    expect(output!.every((byte, index) => byte === content[index])).toBe(true);
    // 63-byte slices would need one push per 63 compressed bytes.
    expect(checks.length).toBeLessThan(compressedSize / 63 / 10);
    let previous = 0;
    let widestBurst = 0;
    let ratioOvershoot = Number.NEGATIVE_INFINITY;
    for (const check of checks) {
      widestBurst = Math.max(widestBurst, check.uncompressed - previous);
      ratioOvershoot = Math.max(
        ratioOvershoot,
        check.uncompressed - DEFAULT_LIMITS.compressionRatio * check.compressed,
      );
      previous = check.uncompressed;
    }
    expect(widestBurst).toBeLessThanOrEqual(4096 * 1032);
    expect(ratioOvershoot).toBeLessThanOrEqual(64 * 1024);
  });

  it('cuts a DEFLATE stream that lies about its size within the slack', async () => {
    const warnings = new WarningSink();
    const sharedBudget = new Budget(DEFAULT_LIMITS, { warnings });
    const archive = openZip(
      makeZip([{ name: 'lie', data: new Uint8Array(8 * 1024 * 1024), method: 8, declaredSize: 1024 }]),
      sharedBudget,
    );
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
    expect(sharedBudget.totalUncompressedBytes).toBeLessThanOrEqual(1024 + 2 * 64 * 1024);
  });

  it('cuts off output that is over the declared size slack', async () => {
    const warnings = new WarningSink();
    const archive = openZip(
      makeZip([{ name: 'lie', data: new Uint8Array(128 * 1024), declaredSize: 0 }]),
      new Budget(DEFAULT_LIMITS, { warnings }),
    );
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(warnings.warnings).toHaveLength(1);
    expect(warnings.warnings[0]?.code).toBe('UNREADABLE_PART');
  });

  it('reports a smaller declared size after completing a stream', async () => {
    const warnings = new WarningSink();
    const archive = openZip(
      makeZip([{ name: 'short claim', data: new Uint8Array([1, 2]), declaredSize: 1 }]),
      new Budget(DEFAULT_LIMITS, { warnings }),
    );
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('checks CRC values after real decompression', async () => {
    const bytes = makeZip([{ name: 'checksum', data: new Uint8Array([1, 2, 3]) }]);
    const central = bytes.findIndex(
      (value, index) => value === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01,
    );
    const checksum = new DataView(bytes.buffer).getUint32(central + 16, true) ^ 1;
    new DataView(bytes.buffer).setUint32(central + 16, checksum, true);
    new DataView(bytes.buffer).setUint32(14, checksum, true);
    const warnings = new WarningSink();
    const archive = openZip(bytes, new Budget(DEFAULT_LIMITS, { warnings }));
    expect(archive.entries[0]?.isUnreadable).toBe(false);
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('reports malformed DEFLATE data and zero-length DEFLATE streams', async () => {
    const invalid = makeZip([{ name: 'bad', data: new Uint8Array([1, 2, 3]), method: 8 }]);
    const central = invalid.findIndex(
      (value, index) => value === 0x50 && invalid[index + 1] === 0x4b && invalid[index + 2] === 0x01,
    );
    const compressedSize = new DataView(invalid.buffer).getUint32(central + 20, true);
    const start = 30 + invalid[26]! + (invalid[27]! << 8) + (invalid[28]! + (invalid[29]! << 8));
    invalid[start] = 0xff;
    const warnings = new WarningSink();
    const archive = openZip(invalid, new Budget(DEFAULT_LIMITS, { warnings }));
    expect(await archive.read(archive.entries[0]!)).toBeNull();
    expect(compressedSize).toBeGreaterThan(0);
    expect(warnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);

    const emptyStream = makeZip([{ name: 'empty-bad', data: new Uint8Array(), method: 8 }]);
    const emptyCentral = emptyStream.findIndex(
      (value, index) => value === 0x50 && emptyStream[index + 1] === 0x4b && emptyStream[index + 2] === 0x01,
    );
    const emptyView = new DataView(emptyStream.buffer);
    emptyView.setUint32(emptyCentral + 20, 0, true);
    emptyView.setUint32(18, 0, true);
    const emptyWarnings = new WarningSink();
    const emptyArchive = openZip(emptyStream, new Budget(DEFAULT_LIMITS, { warnings: emptyWarnings }));
    expect(await emptyArchive.read(emptyArchive.entries[0]!)).toBeNull();
    expect(emptyWarnings.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('rejects bad archive signatures and invalid central-directory bounds', () => {
    expect(() => openZip(new Uint8Array(4), budget())).toThrow(CorruptFileError);
    expect(() => openZip(new Uint8Array(50), budget())).toThrow(CorruptFileError);
    const bytes = makeZip([{ name: 'a', data: new Uint8Array() }]);
    new DataView(bytes.buffer).setUint32(bytes.length - 22 + 16, 0xfffffff0, true);
    expect(() => openZip(bytes, budget())).toThrow(CorruptFileError);
  });

  it('rejects malformed ZIP64 locators, records, disk fields, and counts', () => {
    const badLocator = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    new DataView(badLocator.buffer).setUint32(badLocator.length - 22 - 20, 0, true);
    expect(() => openZip(badLocator, budget())).toThrow(CorruptFileError);

    const unsafeOffset = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    new DataView(unsafeOffset.buffer).setBigUint64(
      unsafeOffset.length - 22 - 20 + 8,
      0xffffffffffffffffn,
      true,
    );
    expect(() => openZip(unsafeOffset, budget())).toThrow(CorruptFileError);

    const multiDisk = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    const zip64Offset = new DataView(multiDisk.buffer).getBigUint64(multiDisk.length - 22 - 20 + 8, true);
    new DataView(multiDisk.buffer).setUint32(Number(zip64Offset) + 16, 1, true);
    expect(() => openZip(multiDisk, budget())).toThrow(CorruptFileError);

    const multiVolume = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    new DataView(multiVolume.buffer).setUint32(multiVolume.length - 22 - 20 + 16, 2, true);
    expect(() => openZip(multiVolume, budget())).toThrow(CorruptFileError);

    const shortRecord = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    const shortView = new DataView(shortRecord.buffer);
    const shortRecordOffset = Number(shortView.getBigUint64(shortRecord.length - 22 - 20 + 8, true));
    shortView.setBigUint64(shortRecordOffset + 4, 10n, true);
    expect(() => openZip(shortRecord, budget())).toThrow(CorruptFileError);

    const countMismatch = makeZip([{ name: 'a', data: new Uint8Array() }], { zip64: true });
    const countView = new DataView(countMismatch.buffer);
    const countRecord = Number(countView.getBigUint64(countMismatch.length - 22 - 20 + 8, true));
    countView.setBigUint64(countRecord + 24, 2n, true);
    expect(() => openZip(countMismatch, budget())).toThrow(CorruptFileError);

    const classicDisk = makeZip([{ name: 'a', data: new Uint8Array() }]);
    new DataView(classicDisk.buffer).setUint16(classicDisk.length - 22 + 4, 1, true);
    expect(() => openZip(classicDisk, budget())).toThrow(CorruptFileError);

    const centralDisk = makeZip([{ name: 'a', data: new Uint8Array() }]);
    const centralDiskOffset = centralDisk.findIndex(
      (value, index) => value === 0x50 && centralDisk[index + 1] === 0x4b && centralDisk[index + 2] === 0x01,
    );
    new DataView(centralDisk.buffer).setUint16(centralDiskOffset + 34, 1, true);
    expect(() => openZip(centralDisk, budget())).toThrow(CorruptFileError);

    const validDiskExtra = makeZip([
      { name: 'a', data: new Uint8Array(), declaredSize: 0x1_0000_0000, zip64DiskStart: 0 },
    ]);
    expect(openZip(validDiskExtra, budget()).entries).toHaveLength(1);
  });

  it('rejects malformed central directory lengths and ZIP64 extra fields', () => {
    const trailing = makeZip([{ name: 'a', data: new Uint8Array() }]);
    const trailingView = new DataView(trailing.buffer);
    const eocd = trailing.length - 22;
    trailingView.setUint32(eocd + 12, trailingView.getUint32(eocd + 12, true) + 1, true);
    expect(() => openZip(trailing, budget())).toThrow(CorruptFileError);

    const badField = makeZip([{ name: 'a', data: new Uint8Array(), declaredSize: 0x1_0000_0000 }]);
    const badFieldCentral = badField.findIndex(
      (value, index) => value === 0x50 && badField[index + 1] === 0x4b && badField[index + 2] === 0x01,
    );
    new DataView(badField.buffer).setUint16(badFieldCentral + 50, 0xffff, true);
    expect(() => openZip(badField, budget())).toThrow(CorruptFileError);

    const missingDisk = makeZip([{ name: 'a', data: new Uint8Array(), declaredSize: 0x1_0000_0000 }]);
    const missingDiskCentral = missingDisk.findIndex(
      (value, index) => value === 0x50 && missingDisk[index + 1] === 0x4b && missingDisk[index + 2] === 0x01,
    );
    new DataView(missingDisk.buffer).setUint16(missingDiskCentral + 34, 0xffff, true);
    expect(() => openZip(missingDisk, budget())).toThrow(CorruptFileError);
  });

  it('lists entries with structurally invalid local headers as unreadable', async () => {
    const badSignature = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    new DataView(badSignature.buffer).setUint32(0, 0, true);
    const badArchive = openZip(badSignature, budget());
    expect(badArchive.entries[0]?.isUnreadable).toBe(true);
    expect(await badArchive.read(badArchive.entries[0]!)).toBeNull();

    const badFlags = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    new DataView(badFlags.buffer).setUint16(6, 1, true);
    expect(openZip(badFlags, budget()).entries[0]?.isUnreadable).toBe(true);

    const badName = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    badName[30] = 0x62;
    expect(openZip(badName, budget()).entries[0]?.isUnreadable).toBe(true);

    const badBounds = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    new DataView(badBounds.buffer).setUint16(28, 0xffff, true);
    expect(openZip(badBounds, budget()).entries[0]?.isUnreadable).toBe(true);

    const badOffset = makeZip([{ name: 'a', data: new Uint8Array([1]) }]);
    const central = badOffset.findIndex(
      (value, index) => value === 0x50 && badOffset[index + 1] === 0x4b && badOffset[index + 2] === 0x01,
    );
    const eocd = badOffset.length - 22;
    new DataView(badOffset.buffer).setUint32(
      central + 42,
      new DataView(badOffset.buffer).getUint32(eocd + 16, true) - 1,
      true,
    );
    expect(openZip(badOffset, budget()).entries[0]?.isUnreadable).toBe(true);
  });

  it('requires bit3-clear local sizes to match central and ZIP64 sizes', async () => {
    const mismatch = makeZip([{ name: 'local-size', data: new Uint8Array([1, 2, 3]) }]);
    new DataView(mismatch.buffer).setUint32(18, 2, true);
    const mismatchArchive = openZip(mismatch, budget());
    expect(mismatchArchive.entries[0]?.isUnreadable).toBe(true);
    expect(await mismatchArchive.read(mismatchArchive.entries[0]!)).toBeNull();

    const validZip64Local = makeZip([
      { name: 'zip64-local', data: new Uint8Array([1]), declaredSize: 0x1_0000_0000 },
    ]);
    expect(openZip(validZip64Local, budget()).entries[0]?.isUnreadable).toBe(false);

    const validZip64LocalBothSizes = makeZip([
      { name: 'zip64-local', data: new Uint8Array([1]), declaredSize: 0x1_0000_0000, zip64Compressed: true },
    ]);
    expect(openZip(validZip64LocalBothSizes, budget()).entries[0]?.isUnreadable).toBe(false);

    const mismatchedZip64Local = makeZip([
      { name: 'zip64-local', data: new Uint8Array([1]), declaredSize: 0x1_0000_0000 },
    ]);
    new DataView(mismatchedZip64Local.buffer).setBigUint64(30 + 'zip64-local'.length + 4, 0n, true);
    expect(openZip(mismatchedZip64Local, budget()).entries[0]?.isUnreadable).toBe(true);

    const mismatchedZip64CompressedLocal = makeZip([
      { name: 'zip64-local', data: new Uint8Array([1]), declaredSize: 0x1_0000_0000, zip64Compressed: true },
    ]);
    new DataView(mismatchedZip64CompressedLocal.buffer).setBigUint64(
      30 + 'zip64-local'.length + 4 + 8,
      0n,
      true,
    );
    expect(openZip(mismatchedZip64CompressedLocal, budget()).entries[0]?.isUnreadable).toBe(true);

    const malformedZip64Local = makeZip([
      { name: 'zip64-local', data: new Uint8Array([1]), declaredSize: 0x1_0000_0000 },
    ]);
    new DataView(malformedZip64Local.buffer).setUint16(28, 4, true);
    expect(openZip(malformedZip64Local, budget()).entries[0]?.isUnreadable).toBe(true);

    const abortController = new AbortController();
    class AbortDuringLocalZip64Budget extends Budget {
      private calls = 0;

      override tick(): void {
        this.calls += 1;
        if (this.calls === 7) abortController.abort();
        super.tick();
      }
    }
    expect(() =>
      openZip(
        validZip64Local,
        new AbortDuringLocalZip64Budget(DEFAULT_LIMITS, { signal: abortController.signal }),
      ),
    ).toThrow(AbortError);
  });

  it('ignores objects that are not one of the archive entries', async () => {
    const archive = openZip(makeZip([{ name: 'a', data: new Uint8Array([1]) }]), budget());
    expect(await archive.read({ ...archive.entries[0]! })).toBeNull();
  });
});

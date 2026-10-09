import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { resolveLimits, type Limits } from '../../src/core/limits.js';
import { AbortError, CorruptFileError, EncryptedError, LimitExceededError } from '../../src/core/errors.js';
import { WarningSink } from '../../src/core/warnings.js';
import { openCfb, type CfbArchive } from '../../src/ole/index.js';
import { decryptOffice } from '../../src/office/encryption/index.js';

interface Fixture {
  name: string;
  file: string;
  password: string;
  plaintext: string;
  info: string;
  package: string;
}
const cases = JSON.parse(
  readFileSync(new URL('./fixtures/cases.json', import.meta.url), 'utf8'),
) as Fixture[];
const decode = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
function context(limits?: Partial<Limits>, signal?: AbortSignal, onLimit?: 'truncate' | 'throw') {
  const warnings = new WarningSink();
  return { budget: new Budget(resolveLimits(limits), { warnings, signal, onLimit }), warnings };
}
function archive(fixture: Fixture, mutate?: (bytes: Uint8Array) => Uint8Array): CfbArchive {
  const info = decode(fixture.info);
  const encrypted = mutate?.(decode(fixture.package)) ?? decode(fixture.package);
  return {
    entries: [
      { path: 'EncryptionInfo', size: info.length, type: 'stream' },
      { path: 'EncryptedPackage', size: encrypted.length, type: 'stream' },
    ],
    read(path) {
      return path === 'EncryptionInfo' ? info : encrypted;
    },
  };
}

describe('Office package decryption', () => {
  it.each(['spin-count-overflow.cfb', 'hmac-tampered.cfb'])(
    'rejects original hostile fixture %s with the public password',
    async (file) => {
      const ctx = context();
      const bytes = new Uint8Array(
        readFileSync(new URL(`../../../../hostile/office/${file}`, import.meta.url)),
      );
      await expect(decryptOffice(openCfb(bytes, ctx.budget), cases[0]!.password, ctx)).rejects.toBeInstanceOf(
        CorruptFileError,
      );
    },
  );
  it.each(cases)('decrypts independent Python-generated $name via real CFB', async (fixture) => {
    const ctx = context();
    const input = new Uint8Array(readFileSync(new URL(`./fixtures/${fixture.file}`, import.meta.url)));
    const cfb = openCfb(input, ctx.budget);
    expect(await decryptOffice(cfb, fixture.password, ctx)).toEqual(decode(fixture.plaintext));
    expect(ctx.warnings.warnings).toEqual([]);
    expect(ctx.budget.totalUncompressedBytes).toBe(
      decode(fixture.info).length + decode(fixture.package).length + decode(fixture.plaintext).length,
    );
  });
  it.each([cases[0]!, cases[3]!])('reports wrong password for $name without plaintext', async (fixture) => {
    await expect(decryptOffice(archive(fixture), 'wrong', context())).rejects.toMatchObject({
      code: 'ENCRYPTED',
      reason: 'wrong-password',
    });
  });
  it('requires a password before reading encrypted streams', async () => {
    const cfb = archive(cases[0]!);
    cfb.read = () => {
      throw new Error('stream should not be read');
    };
    await expect(decryptOffice(cfb, undefined, context())).rejects.toMatchObject({
      reason: 'password-required',
    });
  });
  it('ignores nested marker streams and rejects ambiguous root streams', async () => {
    const cfb = archive(cases[0]!);
    expect(
      await decryptOffice(
        { ...cfb, entries: cfb.entries.map((e) => ({ ...e, path: `nested/${e.path}` })) },
        undefined,
        context(),
      ),
    ).toBeUndefined();
    await expect(
      decryptOffice(
        { ...cfb, entries: [...cfb.entries, { path: 'encryptedpackage', type: 'stream', size: 1 }] },
        'x',
        context(),
      ),
    ).rejects.toBeInstanceOf(CorruptFileError);
    await expect(
      decryptOffice({ ...cfb, entries: [cfb.entries[1]!] }, 'x', context()),
    ).rejects.toBeInstanceOf(CorruptFileError);
  });
  it('validates 64-bit plaintext lengths and complete block lengths', async () => {
    const fixture = cases[3]!;
    for (const mutate of [
      (bytes: Uint8Array) => {
        bytes.fill(255, 0, 8);
        return bytes;
      },
      (bytes: Uint8Array) => bytes.subarray(0, bytes.length - 1),
      (bytes: Uint8Array) => bytes.subarray(0, 7),
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setBigUint64(0, 1n, true);
        return bytes;
      },
    ])
      await expect(
        decryptOffice(archive(fixture, mutate), fixture.password, context()),
      ).rejects.toBeInstanceOf(CorruptFileError);
  });
  it('rejects Agile data and StreamSize tampering by HMAC', async () => {
    const fixture = cases[3]!;
    for (const offset of [0, 100, 4104, decode(fixture.package).length - 1]) {
      await expect(
        decryptOffice(
          archive(fixture, (bytes) => {
            bytes[offset] = bytes[offset]! ^ 1;
            return bytes;
          }),
          fixture.password,
          context(),
        ),
      ).rejects.toBeInstanceOf(CorruptFileError);
    }
  });
  it('bounds the planned plaintext allocation and propagates cancellation', async () => {
    const fixture = cases[3]!;
    const ctx = context({ totalUncompressedBytes: 1 });
    expect(await decryptOffice(archive(fixture), fixture.password, ctx)).toBeUndefined();
    expect(ctx.budget.truncated).toBe(true);
    await expect(
      decryptOffice(
        archive(fixture),
        fixture.password,
        context({ totalUncompressedBytes: 1 }, undefined, 'throw'),
      ),
    ).rejects.toBeInstanceOf(LimitExceededError);
    await expect(
      decryptOffice(archive(fixture), fixture.password, context(undefined, AbortSignal.abort())),
    ).rejects.toBeInstanceOf(AbortError);
  });
  it('preserves supported-encryption error types for unknown EncryptionInfo versions', async () => {
    const cfb = archive(cases[0]!);
    const read = cfb.read.bind(cfb);
    cfb.read = (path) => (path === 'EncryptionInfo' ? new Uint8Array([1, 0, 1, 0]) : read(path));
    await expect(decryptOffice(cfb, 'x', context())).rejects.toBeInstanceOf(EncryptedError);
  });
});

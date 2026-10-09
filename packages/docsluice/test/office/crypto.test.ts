import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { AbortError, CorruptFileError, TimeoutError } from '../../src/core/errors.js';
import {
  decryptCbcRaw,
  decryptEcb,
  iteratePasswordHash,
  utf16le,
} from '../../src/office/encryption/crypto.js';

const hex = (value: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(value.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
const budget = (signal?: AbortSignal, timeMs = 10_000): Budget =>
  new Budget({ ...DEFAULT_LIMITS, timeMs }, { warnings: new WarningSink(), signal });
const key = hex('2b7e151628aed2a6abf7158809cf4f3c');
const plaintext = hex(
  '6bc1bee22e409f96e93d7e117393172aae2d8a571e03ac9c9eb76fac45af8e5130c81c46a35ce411e5fbc1191a0a52eff69f2445df4f9b17ad2b417be66c3710',
);

describe('Office Web Crypto adapters', () => {
  // Published test vectors: NIST SP 800-38A, Appendix F.1.1 and F.2.1.
  it('decrypts unpadded CBC data using the NIST vector', async () => {
    const ciphertext = hex(
      '7649abac8119b246cee98e9b12e9197d5086cb9b507219ee95db113a917678b273bed6b8e3c1743b7116e69e222295163ff1caa1681fac09120eca307586e1a7',
    );
    expect(await decryptCbcRaw(key, hex('000102030405060708090a0b0c0d0e0f'), ciphertext, budget())).toEqual(
      plaintext,
    );
  });

  it('decrypts ECB with Web Crypto CBC using the independent NIST vector', async () => {
    const ciphertext = hex(
      [
        '3ad77bb40d7a3660a89ecaf32466ef97',
        'f5d3d58503b9699de785895a96fdbaaf',
        '43b1cd7f598ece23881b00e3ed030688',
        '7b0c785e27e8ad3f8223207104725dd4',
      ].join(''),
    );
    expect(await decryptEcb(key, ciphertext, budget())).toEqual(plaintext);
  });

  it('keeps arbitrary final zero padding rather than interpreting PKCS padding', async () => {
    const original = new Uint8Array(32);
    original[0] = 7;
    const imported = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, imported, original),
    ).slice(0, 32);
    expect(await decryptCbcRaw(key, new Uint8Array(16), ciphertext, budget())).toEqual(original);
  });

  it('rejects invalid AES sizes and nonintegral blocks', async () => {
    await expect(
      decryptCbcRaw(new Uint8Array(15), new Uint8Array(16), new Uint8Array(16), budget()),
    ).rejects.toBeInstanceOf(CorruptFileError);
    await expect(decryptCbcRaw(key, new Uint8Array(15), new Uint8Array(16), budget())).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    await expect(decryptEcb(key, new Uint8Array(17), budget())).rejects.toBeInstanceOf(CorruptFileError);
    expect(await decryptEcb(key, new Uint8Array(), budget())).toEqual(new Uint8Array());
  });

  it('encodes password code units as UTF-16LE without replacement', () => {
    expect(utf16le('A\u00e9\ud83d\ude00\ud800', budget())).toEqual(hex('4100e9003dd800de00d8'));
  });

  it('hashes the password and little-endian iteration counter as specified', async () => {
    const salt = hex('000102030405060708090a0b0c0d0e0f');
    const initial = new Uint8Array(await crypto.subtle.digest('SHA-512', new Uint8Array([...salt, 65, 0])));
    const expected = new Uint8Array(
      await crypto.subtle.digest('SHA-512', new Uint8Array([0, 0, 0, 0, ...initial])),
    );
    expect(await iteratePasswordHash('A', salt, 'SHA-512', 0, budget())).toEqual(initial);
    expect(await iteratePasswordHash('A', salt, 'SHA-512', 1, budget())).toEqual(expected);
  });

  it('checks cancellation before crypto and during password hashing', async () => {
    const signal = AbortSignal.abort();
    await expect(decryptEcb(key, new Uint8Array(16), budget(signal))).rejects.toBeInstanceOf(AbortError);
    const controller = new AbortController();
    const pending = iteratePasswordHash(
      'password',
      new Uint8Array(16),
      'SHA-512',
      100_000,
      budget(controller.signal),
    );
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('bounds attacker-controlled iterations and enforces the shared time budget', async () => {
    await expect(
      iteratePasswordHash('x', new Uint8Array(16), 'SHA-1', 10_000_001, budget()),
    ).rejects.toBeInstanceOf(CorruptFileError);
    await expect(iteratePasswordHash('x', new Uint8Array(16), 'SHA-1', -1, budget())).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    await expect(
      iteratePasswordHash('x', new Uint8Array(16), 'SHA-1', 1_000_000, budget(undefined, 0)),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

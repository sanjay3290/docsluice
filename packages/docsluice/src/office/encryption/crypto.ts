import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';

export type OfficeHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

function invalid(): CorruptFileError {
  return new CorruptFileError('Office encryption parameters are invalid.');
}

function subtle(): SubtleCrypto {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new EncryptedError('unsupported-encryption');
  return api;
}

/** Owned ArrayBuffer storage also makes subarray inputs safe for Web Crypto. */
function copy(input: Uint8Array, budget: Budget): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index++) {
    budget.tick();
    output[index] = input[index]!;
  }
  return output;
}

export function concat(left: Uint8Array, right: Uint8Array, budget: Budget): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(left.length + right.length);
  for (let index = 0; index < output.length; index++) {
    budget.tick();
    output[index] = index < left.length ? left[index]! : right[index - left.length]!;
  }
  return output;
}

export function utf16le(password: string, budget: Budget): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(password.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < password.length; index++) {
    budget.tick();
    view.setUint16(index * 2, password.charCodeAt(index), true);
  }
  return bytes;
}

export async function digest(
  hash: OfficeHash,
  bytes: Uint8Array,
  budget: Budget,
): Promise<Uint8Array<ArrayBuffer>> {
  budget.tick();
  const result = new Uint8Array(await subtle().digest(hash, copy(bytes, budget)));
  budget.tick();
  return result;
}

export async function iteratePasswordHash(
  password: string,
  salt: Uint8Array,
  hash: OfficeHash,
  iterations: number,
  budget: Budget,
): Promise<Uint8Array<ArrayBuffer>> {
  budget.tick();
  // MS-OFFCRYPTO ST_SpinCount bounds; elapsed work is independently bounded by Budget.
  if (!Number.isSafeInteger(iterations) || iterations < 0 || iterations > 10_000_000) throw invalid();
  let value = await digest(hash, concat(salt, utf16le(password, budget), budget), budget);
  const counter = new Uint8Array(4);
  const view = new DataView(counter.buffer);
  for (let iteration = 0; iteration < iterations; iteration++) {
    budget.tick();
    view.setUint32(0, iteration, true);
    value = await digest(hash, concat(counter, value, budget), budget);
  }
  return value;
}

/**
 * Decrypt complete AES-CBC blocks without treating Office's arbitrary trailing
 * bytes as PKCS#7 padding. Web Crypto supplies a synthetic, valid final padding
 * block: E(lastCiphertext XOR 0x10*16). It removes only that synthetic block.
 */
export async function decryptCbcRaw(
  keyBytes: Uint8Array,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  budget: Budget,
): Promise<Uint8Array<ArrayBuffer>> {
  budget.tick();
  if (![16, 24, 32].includes(keyBytes.length) || iv.length !== 16 || ciphertext.length % 16 !== 0)
    throw invalid();
  if (!ciphertext.length) return new Uint8Array();
  const api = subtle();
  const key = await api.importKey('raw', copy(keyBytes, budget), 'AES-CBC', false, ['encrypt', 'decrypt']);
  budget.tick();
  const finalIv = copy(ciphertext.subarray(ciphertext.length - 16), budget);
  const padding = new Uint8Array(await api.encrypt({ name: 'AES-CBC', iv: finalIv }, key, new Uint8Array()));
  budget.tick();
  const result = new Uint8Array(
    await api.decrypt({ name: 'AES-CBC', iv: copy(iv, budget) }, key, concat(ciphertext, padding, budget)),
  );
  budget.tick();
  return result;
}

/** Derive ECB plaintext from CBC decryption by undoing each previous-block XOR. */
export async function decryptEcb(
  key: Uint8Array,
  ciphertext: Uint8Array,
  budget: Budget,
): Promise<Uint8Array<ArrayBuffer>> {
  const plaintext = await decryptCbcRaw(key, new Uint8Array(16), ciphertext, budget);
  for (let index = 16; index < plaintext.length; index++) {
    budget.tick();
    plaintext[index] = plaintext[index]! ^ ciphertext[index - 16]!;
  }
  return plaintext;
}

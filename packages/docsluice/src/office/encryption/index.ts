import type { CfbArchive } from '../../ole/index.js';
import type { XmlContext } from '../../xml/index.js';
import type { Budget } from '../../core/budget.js';
import { CorruptFileError, EncryptedError } from '../../core/errors.js';
import { concat, decryptCbcRaw, decryptEcb, digest, iteratePasswordHash } from './crypto.js';
import { parseEncryptionInfo, type AgileEncryptionInfo, type StandardEncryptionInfo } from './info.js';

const BLOCKS = [
  [0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79],
  [0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e],
  [0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6],
  [0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6],
  [0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33],
].map((value) => new Uint8Array(value));

function corrupt(): CorruptFileError {
  return new CorruptFileError('The encrypted Office package is invalid.');
}

function resize(input: Uint8Array, length: number, budget: Budget): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    budget.tick();
    result[index] = input[index] ?? 0x36;
  }
  return result;
}

function equal(left: Uint8Array, right: Uint8Array, budget: Budget): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    budget.tick();
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

function counter(index: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, index, true);
  return bytes;
}

/** Root CFB stream names are case-insensitive; duplicate matches fail closed. */
function rootStream(cfb: CfbArchive, name: string, budget: Budget): string | undefined {
  let path: string | undefined;
  for (const entry of cfb.entries) {
    budget.tick();
    if (entry.type !== 'stream' || entry.path.includes('/') || entry.path.toLowerCase() !== name) continue;
    if (path !== undefined) throw corrupt();
    path = entry.path;
  }
  return path;
}

/**
 * Return the original OOXML ZIP bytes for supported root Office encryption
 * streams. No marker means undefined. Reads, KDF work and plaintext allocation
 * all consume the same extraction Budget. This does not register a reader.
 */
export async function decryptOffice(
  cfb: CfbArchive,
  password: string | undefined,
  context: XmlContext,
): Promise<Uint8Array | undefined> {
  const { budget } = context;
  budget.tick();
  const packagePath = rootStream(cfb, 'encryptedpackage', budget);
  if (packagePath === undefined) return undefined;
  if (password === undefined) throw new EncryptedError('password-required');
  const infoPath = rootStream(cfb, 'encryptioninfo', budget);
  if (infoPath === undefined) throw corrupt();
  const infoBytes = cfb.read(infoPath);
  if (budget.truncated) return undefined;
  const info = parseEncryptionInfo(infoBytes, context);
  const encrypted = cfb.read(packagePath);
  if (budget.truncated) return undefined;
  if (encrypted.length < 8) throw corrupt();
  const size64 = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength).getBigUint64(
    0,
    true,
  );
  if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) throw corrupt();
  const size = Number(size64);
  // 4096 is a multiple of the block size, so per-segment rounding equals this.
  if (encrypted.length - 8 !== Math.ceil(size / 16) * 16) throw corrupt();
  if (!budget.checkUncompressed(size)) return undefined;
  if (info.kind === 'standard') return decryptStandard(info, encrypted.subarray(8), size, password, budget);
  return decryptAgile(info, encrypted, size, password, budget);
}

async function standardKey(
  info: StandardEncryptionInfo,
  password: string,
  budget: Budget,
): Promise<Uint8Array> {
  const hash = await iteratePasswordHash(password, info.salt, 'SHA-1', 50_000, budget);
  const final = await digest('SHA-1', concat(hash, counter(0), budget), budget);
  const pieces: Uint8Array[] = [];
  for (const fill of [0x36, 0x5c]) {
    budget.tick();
    const input = new Uint8Array(64).fill(fill);
    for (let index = 0; index < final.length; index++) {
      budget.tick();
      input[index] = input[index]! ^ final[index]!;
    }
    pieces.push(await digest('SHA-1', input, budget));
  }
  return concat(pieces[0]!, pieces[1]!, budget).subarray(0, info.keyBits / 8);
}

async function decryptStandard(
  info: StandardEncryptionInfo,
  ciphertext: Uint8Array,
  size: number,
  password: string,
  budget: Budget,
): Promise<Uint8Array | undefined> {
  const key = await standardKey(info, password, budget);
  const verifier = await decryptEcb(key, info.encryptedVerifier, budget);
  const verifierHash = await decryptEcb(key, info.encryptedVerifierHash, budget);
  if (!equal(await digest('SHA-1', verifier, budget), verifierHash.subarray(0, 20), budget))
    throw new EncryptedError('wrong-password');
  if (!budget.addUncompressed(size)) return undefined;
  const plaintext = await decryptEcb(key, ciphertext, budget);
  return plaintext.subarray(0, size);
}

async function agileIv(
  info: AgileEncryptionInfo,
  block: Uint8Array,
  budget: Budget,
): Promise<Uint8Array<ArrayBuffer>> {
  return resize(
    await digest(info.keyData.hashAlgorithm, concat(info.keyData.salt, block, budget), budget),
    16,
    budget,
  );
}

async function decryptAgile(
  info: AgileEncryptionInfo,
  encrypted: Uint8Array,
  size: number,
  password: string,
  budget: Budget,
): Promise<Uint8Array | undefined> {
  const p = info.password;
  const hash = await iteratePasswordHash(password, p.salt, p.hashAlgorithm, p.spinCount, budget);
  const keys: Uint8Array[] = [];
  for (const block of BLOCKS.slice(0, 3)) {
    budget.tick();
    keys.push(
      resize(await digest(p.hashAlgorithm, concat(hash, block, budget), budget), p.keyBits / 8, budget),
    );
  }
  const iv = resize(p.salt, 16, budget);
  const verifier = await decryptCbcRaw(keys[0]!, iv, p.encryptedVerifierHashInput, budget);
  const verifierHash = await decryptCbcRaw(keys[1]!, iv, p.encryptedVerifierHashValue, budget);
  if (
    !equal(
      await digest(p.hashAlgorithm, verifier.subarray(0, p.saltSize), budget),
      verifierHash.subarray(0, p.hashSize),
      budget,
    )
  )
    throw new EncryptedError('wrong-password');
  const key = (await decryptCbcRaw(keys[2]!, iv, p.encryptedKeyValue, budget)).subarray(
    0,
    info.keyData.keyBits / 8,
  );
  if (info.dataIntegrity) {
    const integrity = info.dataIntegrity;
    const hmacKey = (
      await decryptCbcRaw(key, await agileIv(info, BLOCKS[3]!, budget), integrity.encryptedHmacKey, budget)
    ).subarray(0, info.keyData.saltSize);
    const hmacValue = (
      await decryptCbcRaw(key, await agileIv(info, BLOCKS[4]!, budget), integrity.encryptedHmacValue, budget)
    ).subarray(0, info.keyData.hashSize);
    const api = globalThis.crypto?.subtle;
    if (!api) throw new EncryptedError('unsupported-encryption');
    const imported = await api.importKey(
      'raw',
      resize(hmacKey, hmacKey.length, budget),
      { name: 'HMAC', hash: info.keyData.hashAlgorithm },
      false,
      ['sign'],
    );
    budget.tick();
    const actual = new Uint8Array(
      await api.sign('HMAC', imported, resize(encrypted, encrypted.length, budget)),
    );
    budget.tick();
    if (!equal(actual, hmacValue, budget)) throw corrupt();
  }
  if (!budget.addUncompressed(size)) return undefined;
  const result = new Uint8Array(size);
  let segment = 0;
  for (let offset = 0; offset < size; offset += 4096) {
    budget.tick();
    const remaining = Math.min(4096, size - offset);
    const cipherLength = Math.ceil(remaining / 16) * 16;
    const plain = await decryptCbcRaw(
      key,
      await agileIv(info, counter(segment++), budget),
      encrypted.subarray(8 + offset, 8 + offset + cipherLength),
      budget,
    );
    for (let index = 0; index < remaining; index++) {
      budget.tick();
      result[offset + index] = plain[index]!;
    }
  }
  return result;
}

import { describe, expect, it } from 'vitest';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  StrictModeError,
} from '../../src/core/errors.js';
import { Budget } from '../../src/core/budget.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import type { XmlContext } from '../../src/xml/index.js';
import { parseEncryptionInfo } from '../../src/office/encryption/info.js';

const OFFICE_NS = 'http://schemas.microsoft.com/office/2006/encryption';
const PASSWORD_NS = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';

function context(
  options: {
    signal?: AbortSignal;
    strict?: boolean;
    xmlDepth?: number;
    outputChars?: number;
    onLimit?: 'truncate' | 'throw';
  } = {},
): XmlContext {
  const warnings = new WarningSink({ strict: options.strict });
  return {
    budget: new Budget(
      {
        ...DEFAULT_LIMITS,
        ...(options.xmlDepth === undefined ? {} : { xmlDepth: options.xmlDepth }),
        ...(options.outputChars === undefined ? {} : { outputChars: options.outputChars }),
      },
      { warnings, signal: options.signal, onLimit: options.onLimit },
    ),
    warnings,
  };
}

function bytes(length: number, value = 7): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function base64(value: Uint8Array): string {
  let source = '';
  for (const byte of value) source += String.fromCharCode(byte);
  return btoa(source);
}

interface AgileOptions {
  keyHash?: string;
  passwordHash?: string;
  keyHashSize?: number;
  passwordHashSize?: number;
  keyBits?: number;
  passwordKeyBits?: number;
  passwordSpinCount?: number;
  keySalt?: string;
  keySaltSize?: number;
  passwordSalt?: string;
  passwordSaltSize?: number;
  encryptedVerifierHashInput?: string;
  encryptedVerifierHashValue?: string;
  encryptedKeyValue?: string;
  dataIntegrity?: 'missing' | 'bad-length';
  passwordUri?: string;
  namespace?: string;
  extra?: string;
}

function agileXml(options: AgileOptions = {}): Uint8Array {
  const keyHash = options.keyHash ?? 'SHA256';
  const passwordHash = options.passwordHash ?? keyHash;
  const keyHashSize =
    options.keyHashSize ?? { 'SHA-1': 20, SHA256: 32, SHA384: 48, SHA512: 64 }[keyHash] ?? 32;
  const passwordHashSize = options.passwordHashSize ?? keyHashSize;
  const keyBits = options.keyBits ?? 256;
  const passwordKeyBits = options.passwordKeyBits ?? keyBits;
  const passwordHashCipherLength = Math.ceil(passwordHashSize / 16) * 16;
  const passwordKeyCipherLength = Math.ceil(keyBits / 8 / 16) * 16;
  const keySaltSize = options.keySaltSize ?? 16;
  const passwordSaltSize = options.passwordSaltSize ?? 16;
  const keyNs = options.namespace ?? OFFICE_NS;
  const integrityKeyLength = options.dataIntegrity === 'bad-length' ? 8 : Math.ceil(keySaltSize / 16) * 16;
  const integrityValueLength = Math.ceil(keyHashSize / 16) * 16;
  const dataIntegrity =
    options.dataIntegrity === 'missing'
      ? ''
      : `<dataIntegrity encryptedHmacKey="${base64(bytes(integrityKeyLength, 4))}" encryptedHmacValue="${base64(bytes(integrityValueLength, 5))}"/>`;
  const passwordKeyValue = options.encryptedKeyValue ?? base64(bytes(passwordKeyCipherLength, 3));
  const verifierInput =
    options.encryptedVerifierHashInput ?? base64(bytes(Math.ceil(passwordSaltSize / 16) * 16, 1));
  const verifierValue = options.encryptedVerifierHashValue ?? base64(bytes(passwordHashCipherLength, 2));
  const passwordUri = options.passwordUri ?? PASSWORD_NS;
  const passwordSalt = options.passwordSalt ?? base64(bytes(passwordSaltSize, 8));
  const keySalt = options.keySalt ?? base64(bytes(keySaltSize, 9));
  const passwordAttributes = `saltSize="${passwordSaltSize}" blockSize="16" keyBits="${passwordKeyBits}" hashSize="${passwordHashSize}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="${passwordHash}" saltValue="${passwordSalt}" spinCount="${options.passwordSpinCount ?? 0}" encryptedVerifierHashInput="${verifierInput}" encryptedVerifierHashValue="${verifierValue}" encryptedKeyValue="${passwordKeyValue}"`;
  const xml = new TextEncoder().encode(
    `<encryption xmlns="${keyNs}" xmlns:p="${PASSWORD_NS}"${options.extra ? ` ${options.extra}` : ''}><keyData saltSize="${keySaltSize}" blockSize="16" keyBits="${keyBits}" hashSize="${keyHashSize}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="${keyHash}" saltValue="${keySalt}"/>${dataIntegrity}<keyEncryptors><keyEncryptor uri="${passwordUri}"><p:encryptedKey ${passwordAttributes}/></keyEncryptor></keyEncryptors></encryption>`,
  );
  return withAgilePrefix(xml);
}

function withAgilePrefix(xml: Uint8Array): Uint8Array {
  const result = new Uint8Array(8 + xml.length);
  result.set([4, 0, 4, 0, 0x40, 0, 0, 0]);
  result.set(xml, 8);
  return result;
}

function agileText(value: Uint8Array = agileXml()): string {
  return new TextDecoder().decode(value.subarray(8));
}

interface StandardOptions {
  major?: number;
  minor?: number;
  flags?: number;
  headerFlags?: number;
  headerSize?: number;
  sizeExtra?: number;
  algId?: number;
  hashAlgId?: number;
  keySize?: number;
  reserved2?: number;
  csp?: string;
  includeCspTerminator?: boolean;
  saltSize?: number;
  verifierHashSize?: number;
  trailing?: number;
}

function standardBytes(options: StandardOptions = {}): Uint8Array {
  const csp = options.csp ?? '';
  const hasCsp = csp.length > 0 || options.includeCspTerminator === true;
  // CSPName is UTF-16LE; encode code units explicitly so test data is portable.
  const cspUtf16 = new Uint8Array((csp.length + (hasCsp ? 1 : 0)) * 2);
  for (let index = 0; index < csp.length; index += 1) {
    cspUtf16[index * 2] = csp.charCodeAt(index) & 0xff;
    cspUtf16[index * 2 + 1] = csp.charCodeAt(index) >>> 8;
  }
  const header = new Uint8Array(32 + cspUtf16.length);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, options.headerFlags ?? options.flags ?? 0x24, true);
  headerView.setUint32(4, options.sizeExtra ?? 0, true);
  headerView.setUint32(8, options.algId ?? 0x660f, true);
  headerView.setUint32(12, options.hashAlgId ?? 0x8004, true);
  headerView.setUint32(16, options.keySize ?? 192, true);
  headerView.setUint32(20, 0x18, true);
  headerView.setUint32(24, 0, true);
  headerView.setUint32(28, options.reserved2 ?? 0, true);
  header.set(cspUtf16, 32);
  const headerSize = options.headerSize ?? header.length;
  const tail = new Uint8Array(4 + 16 + 16 + 4 + 32 + (options.trailing ?? 0));
  const tailView = new DataView(tail.buffer);
  tailView.setUint32(0, options.saltSize ?? 16, true);
  tail.fill(10, 4, 20);
  tail.fill(11, 20, 36);
  tailView.setUint32(36, options.verifierHashSize ?? 20, true);
  tail.fill(12, 40, 72);
  const result = new Uint8Array(12 + header.length + tail.length);
  const view = new DataView(result.buffer);
  view.setUint16(0, options.major ?? 4, true);
  view.setUint16(2, options.minor ?? 2, true);
  view.setUint32(4, options.flags ?? 0x24, true);
  view.setUint32(8, headerSize, true);
  result.set(header, 12);
  result.set(tail, 12 + header.length);
  if (options.headerSize !== undefined && options.headerSize !== header.length) {
    const newLength = 12 + headerSize + tail.length;
    const resized = new Uint8Array(Math.max(0, newLength));
    resized.set(result.subarray(0, Math.min(resized.length, 12 + header.length)));
    if (headerSize <= header.length) resized.set(tail, 12 + headerSize);
    return resized;
  }
  return result;
}

describe('parseEncryptionInfo', () => {
  it('parses Agile key data, password key data, and optional integrity values separately', () => {
    const parsed = parseEncryptionInfo(agileXml(), context());
    expect(parsed).toEqual({
      kind: 'agile',
      keyData: { salt: bytes(16, 9), saltSize: 16, keyBits: 256, hashAlgorithm: 'SHA-256', hashSize: 32 },
      password: {
        salt: bytes(16, 8),
        saltSize: 16,
        keyBits: 256,
        hashAlgorithm: 'SHA-256',
        hashSize: 32,
        spinCount: 0,
        encryptedVerifierHashInput: bytes(16, 1),
        encryptedVerifierHashValue: bytes(32, 2),
        encryptedKeyValue: bytes(32, 3),
      },
      dataIntegrity: { encryptedHmacKey: bytes(16, 4), encryptedHmacValue: bytes(32, 5) },
    });
  });

  it('uses keyData salt size for encrypted HMAC key and password salt/keyData key sizes for wrapped values', () => {
    const parsed = parseEncryptionInfo(
      agileXml({
        keyHash: 'SHA384',
        passwordHash: 'SHA384',
        keySaltSize: 16,
        passwordSaltSize: 20,
        keyBits: 256,
        passwordKeyBits: 128,
      }),
      context(),
    );
    expect(parsed.kind).toBe('agile');
    if (parsed.kind === 'agile') {
      expect(parsed.keyData.saltSize).toBe(16);
      expect(parsed.keyData.hashSize).toBe(48);
      expect(parsed.password.saltSize).toBe(20);
      expect(parsed.password.keyBits).toBe(128);
      expect(parsed.password.encryptedVerifierHashInput).toHaveLength(32);
      expect(parsed.password.encryptedKeyValue).toHaveLength(32);
      expect(parsed.dataIntegrity?.encryptedHmacKey).toHaveLength(16);
      expect(parsed.dataIntegrity?.encryptedHmacValue).toHaveLength(48);
    }
  });

  it('rejects encrypted verifier input shorter than the password salt size', () => {
    const malformed = agileXml({
      dataIntegrity: 'missing',
      passwordSaltSize: 20,
      encryptedVerifierHashInput: base64(bytes(16, 1)),
    });
    expect(() => parseEncryptionInfo(malformed, context())).toThrow(CorruptFileError);
  });

  it('rejects encryptedKeyValue shorter than the keyData key size', () => {
    const malformed = agileXml({
      dataIntegrity: 'missing',
      keyBits: 256,
      passwordKeyBits: 128,
      encryptedKeyValue: base64(bytes(16, 3)),
    });
    expect(() => parseEncryptionInfo(malformed, context())).toThrow(CorruptFileError);
  });

  it.each([
    ['SHA-1', 20, 'SHA-1'],
    ['SHA256', 32, 'SHA-256'],
    ['SHA384', 48, 'SHA-384'],
    ['SHA512', 64, 'SHA-512'],
  ])('normalizes supported Agile hash %s', (hash, hashSize, normalized) => {
    const parsed = parseEncryptionInfo(agileXml({ keyHash: hash, passwordHash: hash }), context());
    expect(parsed.kind).toBe('agile');
    if (parsed.kind === 'agile') {
      expect(parsed.keyData.hashAlgorithm).toBe(normalized);
      expect(parsed.password.hashAlgorithm).toBe(normalized);
      expect(parsed.keyData.salt).toHaveLength(16);
      expect(parsed.dataIntegrity?.encryptedHmacValue).toHaveLength(Math.ceil(hashSize / 16) * 16);
    }
  });

  it.each([128, 192, 256])('accepts AES-%s Agile key sizes independently', (keyBits) => {
    const parsed = parseEncryptionInfo(agileXml({ keyBits, passwordKeyBits: 128 }), context());
    expect(parsed.kind).toBe('agile');
    if (parsed.kind === 'agile') {
      expect(parsed.keyData.keyBits).toBe(keyBits);
      expect(parsed.password.keyBits).toBe(128);
      expect(parsed.password.encryptedKeyValue).toHaveLength(Math.ceil(keyBits / 8 / 16) * 16);
    }
  });

  it('accepts the maximum declared Agile password spin count without doing work', () => {
    const parsed = parseEncryptionInfo(agileXml({ passwordSpinCount: 10_000_000 }), context());
    expect(parsed.kind).toBe('agile');
    if (parsed.kind === 'agile') expect(parsed.password.spinCount).toBe(10_000_000);
  });

  it('parses Standard AES-192 verifier information', () => {
    expect(parseEncryptionInfo(standardBytes(), context())).toEqual({
      kind: 'standard',
      version: 4,
      keyBits: 192,
      hashAlgorithm: 'SHA-1',
      salt: bytes(16, 10),
      encryptedVerifier: bytes(16, 11),
      verifierHashSize: 20,
      encryptedVerifierHash: bytes(32, 12),
    });
  });

  it('accepts an Agile descriptor without the optional integrity element', () => {
    const parsed = parseEncryptionInfo(agileXml({ dataIntegrity: 'missing' }), context());
    expect(parsed.kind).toBe('agile');
    if (parsed.kind === 'agile') expect(parsed.dataIntegrity).toBeUndefined();
  });

  it.each([2, 3, 4])('accepts Standard major version %s', (major) => {
    expect(parseEncryptionInfo(standardBytes({ major }), context()).kind).toBe('standard');
  });

  it('accepts a correctly terminated optional Standard CSP name', () => {
    const parsed = parseEncryptionInfo(standardBytes({ csp: 'Test Provider' }), context());
    expect(parsed.kind).toBe('standard');
  });

  it('accepts XML whitespace around URI tokens and between Agile elements', () => {
    const xml = agileText()
      .replace(`<keyData`, ` \n<keyData`)
      .replace(`</keyData><dataIntegrity`, `</keyData> \n <dataIntegrity`)
      .replace(
        'uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password"',
        'uri="\n http://schemas.microsoft.com/office/2006/keyEncryptor/password \t"',
      );
    expect(parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context()).kind).toBe('agile');
  });

  it.each([
    [
      'bad Agile version',
      () => {
        const value = agileXml();
        value[0] = value[0]! ^ 1;
        return value;
      },
    ],
    [
      'bad Agile reserved word',
      () => {
        const value = agileXml();
        value[4] = 0x41;
        return value;
      },
    ],
    ['wrong root namespace', () => agileXml({ namespace: 'urn:wrong' })],
    [
      'missing required Agile keyData',
      () =>
        withAgilePrefix(
          new TextEncoder().encode(
            '<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption"><keyEncryptors/></encryption>',
          ),
        ),
    ],
    [
      'duplicate direct keyData',
      () => {
        const xml = agileText();
        const start = xml.indexOf('<keyData');
        const end = xml.indexOf('/>', start) + 2;
        return new TextEncoder().encode(`${xml.slice(0, end)}${xml.slice(start, end)}${xml.slice(end)}`);
      },
    ],
    [
      'duplicate password key encryptor',
      () => {
        const xml = agileText();
        const start = xml.indexOf('<keyEncryptor');
        const end = xml.indexOf('</keyEncryptor>') + '</keyEncryptor>'.length;
        return new TextEncoder().encode(`${xml.slice(0, end)}${xml.slice(start, end)}${xml.slice(end)}`);
      },
    ],
    ['namespaced schema attribute', () => agileXml({ extra: 'x:bad="1" xmlns:x="urn:x"' })],
    ['malformed base64', () => agileXml({ passwordSalt: '!!!!' })],
    ['salt length mismatch', () => agileXml({ passwordSalt: base64(bytes(15)) })],
    [
      'salt size exceeds spec',
      () => {
        const value = agileXml();
        return new Uint8Array([
          ...value.subarray(0, 8),
          ...new TextEncoder().encode(agileText(value).replace('saltSize="16"', 'saltSize="65537"')),
        ]);
      },
    ],
    ['inconsistent password hash', () => agileXml({ passwordHash: 'SHA512' })],
    ['unsupported AES key size', () => agileXml({ keyBits: 160 })],
    ['incorrect encrypted HMAC length', () => agileXml({ dataIntegrity: 'bad-length' })],
    ['spin count exceeds spec', () => agileXml({ passwordSpinCount: 10_000_001 })],
    ['unsupported Agile hash', () => agileXml({ keyHash: 'MD5' })],
    [
      'unsupported Agile cipher',
      () =>
        new TextEncoder().encode(
          new TextDecoder().decode(agileXml()).replaceAll('cipherAlgorithm="AES"', 'cipherAlgorithm="RC4"'),
        ),
    ],
  ])('rejects %s as corrupt or unsupported', (_label, makeBytes) => {
    expect(() => parseEncryptionInfo(makeBytes(), context())).toThrow();
  });

  it('requires exactly one password encryptor even when other encryptors are present', () => {
    const xml = agileText();
    const marker = '<keyEncryptors>';
    const insert = `<keyEncryptor uri="${PASSWORD_NS}"><p:encryptedKey saltSize="16"/></keyEncryptor>`;
    const altered = new TextEncoder().encode(xml.replace(marker, `${marker}${insert}`));
    const stream = new Uint8Array(8 + altered.length);
    stream.set([4, 0, 4, 0, 0x40, 0, 0, 0]);
    stream.set(altered, 8);
    expect(() => parseEncryptionInfo(stream, context())).toThrow(CorruptFileError);
  });

  it('uses unsupported-encryption for a valid but unsupported password hash', () => {
    expect(() => parseEncryptionInfo(agileXml({ keyHash: 'MD5' }), context())).toThrow(
      new EncryptedError('unsupported-encryption'),
    );
  });

  it('uses unsupported-encryption for a valid but unsupported Agile cipher mode', () => {
    const bytes = agileXml();
    const xml = agileText(bytes).replaceAll('ChainingModeCBC', 'ChainingModeCFB');
    expect(() => parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context())).toThrow(
      new EncryptedError('unsupported-encryption'),
    );
  });

  it('rejects a second top-level Agile XML element', () => {
    const xml = `${agileText()}<unexpected/>`;
    expect(() => parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context())).toThrow(
      CorruptFileError,
    );
  });

  it('rejects non-whitespace outside the Agile XML root', () => {
    const xml = `extra${agileText()}`;
    expect(() => parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context())).toThrow(
      CorruptFileError,
    );
  });

  it('rejects a descriptor scan truncated before malformed trailing text', () => {
    const xml = agileText(agileXml({ dataIntegrity: 'missing' })) + '!'.repeat(20);
    expect(() =>
      parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context({ outputChars: 1 })),
    ).toThrow(LimitExceededError);
  });

  it('rejects a descriptor tree truncated before an extra nested element', () => {
    const source = agileText(agileXml({ dataIntegrity: 'missing' }));
    const xml = source.replace(
      '/></keyEncryptor>',
      '><unexpected><nested/></unexpected></p:encryptedKey></keyEncryptor>',
    );
    expect(() =>
      parseEncryptionInfo(withAgilePrefix(new TextEncoder().encode(xml)), context({ xmlDepth: 4 })),
    ).toThrow(LimitExceededError);
  });

  it('preserves an XML depth budget error', () => {
    expect(() => parseEncryptionInfo(agileXml(), context({ xmlDepth: 0, onLimit: 'throw' }))).toThrow(
      LimitExceededError,
    );
  });

  it('accepts base64 XML whitespace but rejects non-canonical padding bits', () => {
    const valid = agileXml({
      passwordSalt: `${base64(bytes(16, 8)).slice(0, -4)}\n ${base64(bytes(16, 8)).slice(-4)}`,
    });
    expect(parseEncryptionInfo(valid, context()).kind).toBe('agile');
    const badSalt = base64(bytes(16, 8)).replace(/CA==$/, 'CB==');
    expect(() => parseEncryptionInfo(agileXml({ passwordSalt: badSalt }), context())).toThrow(
      CorruptFileError,
    );
  });

  it.each([
    ['mismatched duplicated flags', { flags: 0x24, headerFlags: 0x20 }],
    ['missing AES flags', { flags: 0x04, headerFlags: 0x04 }],
    ['docprops flag', { flags: 0x2c, headerFlags: 0x2c }],
    ['nonzero SizeExtra', { sizeExtra: 1 }],
    ['nonzero Reserved2', { reserved2: 1 }],
    ['wrong AES key length', { keySize: 128 }],
    ['wrong verifier salt size', { saltSize: 15 }],
    ['wrong verifier hash size', { verifierHashSize: 19 }],
    ['trailing Standard bytes', { trailing: 1 }],
    ['truncated header', { headerSize: 31 }],
  ])('rejects malformed Standard %s', (_label, options) => {
    expect(() => parseEncryptionInfo(standardBytes(options), context())).toThrow(CorruptFileError);
  });

  it('rejects a Standard header with a CSP name that lacks a null terminator', () => {
    const good = standardBytes({ csp: 'X' });
    const value = new Uint8Array(good);
    value[value.length - 72 - 2] = 88;
    value[value.length - 72 - 1] = 0;
    expect(() => parseEncryptionInfo(value, context())).toThrow(CorruptFileError);
  });

  it('classifies unsupported Standard algorithms without treating the stream as corrupt', () => {
    expect(() => parseEncryptionInfo(standardBytes({ algId: 0x660d }), context())).toThrow(
      new EncryptedError('unsupported-encryption'),
    );
  });

  it('preserves abort and strict DTD errors from the shared XML context', () => {
    const abort = new AbortController();
    abort.abort();
    expect(() => parseEncryptionInfo(agileXml(), context({ signal: abort.signal }))).toThrow(AbortError);
    const dtd = new Uint8Array([
      ...agileXml().subarray(0, 8),
      ...new TextEncoder().encode(`<!DOCTYPE encryption>${agileText()}`),
    ]);
    expect(() => parseEncryptionInfo(dtd, context({ strict: true }))).toThrow(StrictModeError);
  });
});

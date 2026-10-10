import { CorruptFileError, EncryptedError, LimitExceededError } from '../../core/errors.js';
import type { XmlContext } from '../../xml/index.js';
import { parseXml, scanXml, type XmlElement } from '../../xml/index.js';

const AGILE_NAMESPACE = 'http://schemas.microsoft.com/office/2006/encryption';
const PASSWORD_NAMESPACE = 'http://schemas.microsoft.com/office/2006/keyEncryptor/password';
const AES_BLOCK_SIZE = 16;
const MAX_AGILE_SALT = 65_536;
const MAX_SPIN_COUNT = 10_000_000;
export type OfficeHashName = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';
const HASHES = new Map<string, { webCrypto: OfficeHashName; size: number }>([
  ['SHA-1', { webCrypto: 'SHA-1', size: 20 }],
  ['SHA256', { webCrypto: 'SHA-256', size: 32 }],
  ['SHA384', { webCrypto: 'SHA-384', size: 48 }],
  ['SHA512', { webCrypto: 'SHA-512', size: 64 }],
]);

/** Parameters for the package contents encrypted by Agile encryption. */
export interface AgileKeyData {
  salt: Uint8Array;
  saltSize: number;
  keyBits: 128 | 192 | 256;
  hashAlgorithm: OfficeHashName;
  hashSize: number;
}

/** Password-based parameters and ciphertext used to recover an Agile intermediate key. */
export interface AgilePasswordKey {
  salt: Uint8Array;
  saltSize: number;
  keyBits: 128 | 192 | 256;
  hashAlgorithm: OfficeHashName;
  hashSize: number;
  spinCount: number;
  encryptedVerifierHashInput: Uint8Array;
  encryptedVerifierHashValue: Uint8Array;
  encryptedKeyValue: Uint8Array;
}

/** Optional encrypted HMAC key and value from an Agile descriptor. */
export interface AgileDataIntegrity {
  encryptedHmacKey: Uint8Array;
  encryptedHmacValue: Uint8Array;
}

/** Parsed Agile EncryptionInfo stream descriptor. */
export interface AgileEncryptionInfo {
  kind: 'agile';
  keyData: AgileKeyData;
  password: AgilePasswordKey;
  dataIntegrity?: AgileDataIntegrity;
}

/** Parsed Standard EncryptionInfo stream descriptor. */
export interface StandardEncryptionInfo {
  kind: 'standard';
  version: 2 | 3 | 4;
  keyBits: 128 | 192 | 256;
  hashAlgorithm: 'SHA-1';
  salt: Uint8Array;
  encryptedVerifier: Uint8Array;
  verifierHashSize: 20;
  encryptedVerifierHash: Uint8Array;
}

/** Parse an Office EncryptionInfo stream descriptor without doing cryptography. */
export function parseEncryptionInfo(
  bytes: Uint8Array,
  context: XmlContext,
): AgileEncryptionInfo | StandardEncryptionInfo {
  context.budget.tick();
  if (bytes.byteLength < 4) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const major = view.getUint16(0, true);
  const minor = view.getUint16(2, true);

  if (major === 4 && minor === 4) {
    if (bytes.byteLength < 8 || view.getUint32(4, true) !== 0x40) throw corrupt();
    return parseAgile(bytes.subarray(8), context);
  }
  if (major !== 2 && major !== 3 && major !== 4) throw unsupported();
  if (minor !== 2) throw unsupported();
  return parseStandard(bytes, view, major, context);
}

function parseAgile(xml: Uint8Array, context: XmlContext): AgileEncryptionInfo {
  const warningStart = context.warnings.warnings.length;
  validateXmlEnvelope(xml, context);
  const root = parseXml(xml, context);
  if (!root) throw corrupt();
  ensureXmlScanComplete(context, warningStart);
  if (root.localName !== 'encryption' || root.namespaceURI !== AGILE_NAMESPACE) throw corrupt();
  validateAttributes(root, [], context);
  const children = elementChildren(root, context);
  if (children.length < 2 || children.length > 3) throw corrupt();
  const keyDataElement = children[0];
  if (keyDataElement?.localName !== 'keyData' || keyDataElement.namespaceURI !== AGILE_NAMESPACE)
    throw corrupt();
  const keyData = parseKeyParameters(keyDataElement, context);
  let childIndex = 1;
  let dataIntegrity: AgileDataIntegrity | undefined;
  if (children[childIndex]?.localName === 'dataIntegrity') {
    const integrity = children[childIndex];
    if (integrity?.namespaceURI !== AGILE_NAMESPACE) throw corrupt();
    dataIntegrity = parseDataIntegrity(integrity, keyData.salt.length, keyData.hash.size, context);
    childIndex += 1;
  }
  const keyEncryptors = children[childIndex];
  if (
    childIndex !== children.length - 1 ||
    keyEncryptors?.localName !== 'keyEncryptors' ||
    keyEncryptors.namespaceURI !== AGILE_NAMESPACE
  )
    throw corrupt();
  validateAttributes(keyEncryptors, [], context);
  const encryptors = elementChildren(keyEncryptors, context);
  let password: AgilePasswordKey | undefined;
  for (const encryptor of encryptors) {
    context.budget.tick();
    if (encryptor.localName !== 'keyEncryptor' || encryptor.namespaceURI !== AGILE_NAMESPACE) throw corrupt();
    const uri = optionalAttribute(encryptor, 'uri', context);
    validateAttributes(encryptor, uri === undefined ? [] : ['uri'], context);
    if (uri !== PASSWORD_NAMESPACE) continue;
    if (password) throw corrupt();
    const key = onlyElementChild(encryptor, context);
    if (key.localName !== 'encryptedKey' || key.namespaceURI !== PASSWORD_NAMESPACE) throw corrupt();
    const parsed = parsePasswordKey(key, keyData.keyBits, context);
    if (
      parsed.hash.algorithm !== keyData.hash.algorithm ||
      parsed.cipher !== keyData.cipher ||
      parsed.chaining !== keyData.chaining
    )
      throw corrupt();
    password = parsed.value;
  }
  if (!password) throw corrupt();
  return {
    kind: 'agile',
    keyData: {
      salt: keyData.salt,
      saltSize: keyData.salt.length,
      keyBits: keyData.keyBits,
      hashAlgorithm: keyData.hash.algorithm,
      hashSize: keyData.hash.size,
    },
    password,
    ...(dataIntegrity ? { dataIntegrity } : {}),
  };
}

function validateXmlEnvelope(xml: Uint8Array, context: XmlContext): void {
  let depth = 0;
  let rootCount = 0;
  let outsideText = false;
  const warningStart = context.warnings.warnings.length;
  scanXml(
    xml,
    {
      onOpen() {
        context.budget.tick();
        if (depth === 0) rootCount += 1;
        depth += 1;
      },
      onText(text) {
        if (depth === 0 && !isXmlWhitespace(text, context)) outsideText = true;
      },
      onClose() {
        context.budget.tick();
        depth -= 1;
      },
    },
    context,
  );
  for (const warning of context.warnings.warnings.slice(warningStart)) {
    context.budget.tick();
    if (warning.code === 'UNREADABLE_PART') throw corrupt();
  }
  ensureXmlScanComplete(context, warningStart);
  if (rootCount !== 1 || outsideText) throw corrupt();
}

function ensureXmlScanComplete(context: XmlContext, warningStart: number): void {
  const warnings = context.warnings.warnings;
  const start = context.budget.truncated ? 0 : warningStart;
  for (let index = start; index < warnings.length; index += 1) {
    context.budget.tick();
    const warning = warnings[index]!;
    if (warning.code === 'UNREADABLE_PART') throw corrupt();
    if (warning.code === 'TRUNCATED' && warning.message.startsWith('Limit "outputChars"')) {
      throw new LimitExceededError('outputChars', context.budget.limits.outputChars);
    }
    if (warning.message.startsWith('Limit "xmlDepth"')) {
      throw new LimitExceededError('xmlDepth', context.budget.limits.xmlDepth);
    }
  }
}

interface KeyParameters {
  salt: Uint8Array;
  keyBits: 128 | 192 | 256;
  hash: { algorithm: OfficeHashName; size: number };
  cipher: 'AES';
  chaining: 'ChainingModeCBC';
}

function parseKeyParameters(element: XmlElement, context: XmlContext): KeyParameters {
  validateAttributes(
    element,
    [
      'saltSize',
      'blockSize',
      'keyBits',
      'hashSize',
      'cipherAlgorithm',
      'cipherChaining',
      'hashAlgorithm',
      'saltValue',
    ],
    context,
  );
  requireNoElementChildren(element, context);
  const saltSize = unsignedAttribute(element, 'saltSize', context);
  const blockSize = unsignedAttribute(element, 'blockSize', context);
  const keyBits = keyBitsAttribute(element, 'keyBits', context);
  const hash = hashAttribute(element, 'hashAlgorithm');
  const hashSize = unsignedAttribute(element, 'hashSize', context);
  if (saltSize < 1 || saltSize > MAX_AGILE_SALT || blockSize !== AES_BLOCK_SIZE || hashSize !== hash.size)
    throw corrupt();
  const cipher = requiredAttribute(element, 'cipherAlgorithm');
  const chaining = requiredAttribute(element, 'cipherChaining');
  if (cipher !== 'AES' || chaining !== 'ChainingModeCBC') throw unsupported();
  const salt = decodeBase64(requiredAttribute(element, 'saltValue'), context, saltSize);
  return { salt, keyBits, hash, cipher, chaining };
}

function parsePasswordKey(
  element: XmlElement,
  keyDataKeyBits: number,
  context: XmlContext,
): {
  value: AgilePasswordKey;
  hash: { algorithm: OfficeHashName; size: number };
  cipher: string;
  chaining: string;
} {
  validateAttributes(
    element,
    [
      'saltSize',
      'blockSize',
      'keyBits',
      'hashSize',
      'cipherAlgorithm',
      'cipherChaining',
      'hashAlgorithm',
      'saltValue',
      'spinCount',
      'encryptedVerifierHashInput',
      'encryptedVerifierHashValue',
      'encryptedKeyValue',
    ],
    context,
  );
  requireNoElementChildren(element, context);
  const saltSize = unsignedAttribute(element, 'saltSize', context);
  const blockSize = unsignedAttribute(element, 'blockSize', context);
  const keyBits = keyBitsAttribute(element, 'keyBits', context);
  const hash = hashAttribute(element, 'hashAlgorithm');
  const hashSize = unsignedAttribute(element, 'hashSize', context);
  const spinCount = unsignedAttribute(element, 'spinCount', context);
  if (
    saltSize < 1 ||
    saltSize > MAX_AGILE_SALT ||
    blockSize !== AES_BLOCK_SIZE ||
    hashSize !== hash.size ||
    spinCount > MAX_SPIN_COUNT
  )
    throw corrupt();
  const cipher = requiredAttribute(element, 'cipherAlgorithm');
  const chaining = requiredAttribute(element, 'cipherChaining');
  if (cipher !== 'AES' || chaining !== 'ChainingModeCBC') throw unsupported();
  const salt = decodeBase64(requiredAttribute(element, 'saltValue'), context, saltSize);
  const encryptedVerifierHashInput = decodeBase64(
    requiredAttribute(element, 'encryptedVerifierHashInput'),
    context,
    roundToBlock(saltSize),
  );
  const encryptedVerifierHashValue = decodeBase64(
    requiredAttribute(element, 'encryptedVerifierHashValue'),
    context,
    roundToBlock(hash.size),
  );
  const encryptedKeyValue = decodeBase64(
    requiredAttribute(element, 'encryptedKeyValue'),
    context,
    roundToBlock(keyDataKeyBits / 8),
  );
  return {
    value: {
      salt,
      saltSize: salt.length,
      keyBits,
      hashAlgorithm: hash.algorithm,
      hashSize: hash.size,
      spinCount,
      encryptedVerifierHashInput,
      encryptedVerifierHashValue,
      encryptedKeyValue,
    },
    hash,
    cipher,
    chaining,
  };
}

function parseDataIntegrity(
  element: XmlElement,
  saltSize: number,
  hashSize: number,
  context: XmlContext,
): AgileDataIntegrity {
  validateAttributes(element, ['encryptedHmacKey', 'encryptedHmacValue'], context);
  requireNoElementChildren(element, context);
  return {
    encryptedHmacKey: decodeBase64(
      requiredAttribute(element, 'encryptedHmacKey'),
      context,
      roundToBlock(saltSize),
    ),
    encryptedHmacValue: decodeBase64(
      requiredAttribute(element, 'encryptedHmacValue'),
      context,
      roundToBlock(hashSize),
    ),
  };
}

function parseStandard(
  bytes: Uint8Array,
  view: DataView,
  major: 2 | 3 | 4,
  context: XmlContext,
): StandardEncryptionInfo {
  if (bytes.byteLength < 12) throw corrupt();
  const flags = view.getUint32(4, true);
  const headerSize = view.getUint32(8, true);
  if (!hasBytes(bytes, 12, headerSize) || headerSize < 32) throw corrupt();
  const headerOffset = 12;
  const header = new DataView(bytes.buffer, bytes.byteOffset + headerOffset, headerSize);
  const headerFlags = header.getUint32(0, true);
  const requiredFlags = 0x04 | 0x20;
  if (flags !== headerFlags || (flags & requiredFlags) !== requiredFlags || (flags & 0x08) !== 0)
    throw corrupt();
  const sizeExtra = header.getUint32(4, true);
  const algId = header.getUint32(8, true);
  const hashAlgId = header.getUint32(12, true);
  const keySize = header.getUint32(16, true);
  const reserved2 = header.getUint32(28, true);
  if (sizeExtra !== 0 || reserved2 !== 0) throw corrupt();
  const algorithmKeyBits =
    algId === 0x660e ? 128 : algId === 0x660f ? 192 : algId === 0x6610 ? 256 : undefined;
  if (algorithmKeyBits === undefined || hashAlgId !== 0x8004) throw unsupported();
  if (keySize !== algorithmKeyBits) throw corrupt();
  validateCspName(bytes, headerOffset, headerSize, context);
  const tailOffset = 12 + headerSize;
  const verifierLength = 4 + 16 + 16 + 4 + 32;
  if (bytes.byteLength !== tailOffset + verifierLength) throw corrupt();
  const verifier = new DataView(bytes.buffer, bytes.byteOffset + tailOffset, verifierLength);
  if (verifier.getUint32(0, true) !== 16) throw corrupt();
  if (verifier.getUint32(36, true) !== 20) throw corrupt();
  return {
    kind: 'standard',
    version: major,
    keyBits: algorithmKeyBits,
    hashAlgorithm: 'SHA-1',
    salt: bytes.slice(tailOffset + 4, tailOffset + 20),
    encryptedVerifier: bytes.slice(tailOffset + 20, tailOffset + 36),
    verifierHashSize: 20,
    encryptedVerifierHash: bytes.slice(tailOffset + 40, tailOffset + 72),
  };
}

function validateCspName(
  bytes: Uint8Array,
  headerOffset: number,
  headerSize: number,
  context: XmlContext,
): void {
  const cspLength = headerSize - 32;
  if (cspLength === 0) return;
  if (cspLength < 2 || cspLength % 2 !== 0) throw corrupt();
  const csp = bytes.subarray(headerOffset + 32, headerOffset + headerSize);
  if (csp[csp.length - 2] !== 0 || csp[csp.length - 1] !== 0) throw corrupt();
  for (let offset = 0; offset < csp.length - 2; offset += 2) {
    context.budget.tick();
    if (csp[offset] === 0 && csp[offset + 1] === 0) throw corrupt();
  }
  try {
    new TextDecoder('utf-16le', { fatal: true }).decode(csp);
  } catch {
    throw corrupt();
  }
}

function elementChildren(element: XmlElement, context: XmlContext): XmlElement[] {
  const children: XmlElement[] = [];
  for (const child of element.children) {
    context.budget.tick();
    if (typeof child === 'string') {
      if (!isXmlWhitespace(child, context)) throw corrupt();
    } else children.push(child);
  }
  return children;
}

function onlyElementChild(element: XmlElement, context: XmlContext): XmlElement {
  const children = elementChildren(element, context);
  if (children.length !== 1) throw corrupt();
  return children[0]!;
}

function requireNoElementChildren(element: XmlElement, context: XmlContext): void {
  if (elementChildren(element, context).length !== 0) throw corrupt();
}

function validateAttributes(element: XmlElement, expected: readonly string[], context: XmlContext): void {
  const seen = new Set<string>();
  for (const [name] of element.attrs) {
    context.budget.tick();
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    if (name.includes(':') || !expected.includes(name) || seen.has(name)) throw corrupt();
    seen.add(name);
  }
  if (seen.size !== expected.length) throw corrupt();
}

function requiredAttribute(element: XmlElement, name: string): string {
  const value = element.attrs.get(name);
  if (value === undefined) throw corrupt();
  return value;
}

function optionalAttribute(element: XmlElement, name: string, context: XmlContext): string | undefined {
  const value = element.attrs.get(name);
  if (value === undefined) return undefined;
  return collapseXmlWhitespace(value, context);
}

function unsignedAttribute(element: XmlElement, name: string, context: XmlContext): number {
  const raw = requiredAttribute(element, name);
  const value = collapseXmlWhitespace(raw, context);
  if (value.length === 0) throw corrupt();
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    context.budget.tick();
    const digit = value.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9 || result > Math.floor((0xffff_ffff - digit) / 10)) throw corrupt();
    result = result * 10 + digit;
  }
  return result;
}

function keyBitsAttribute(element: XmlElement, name: string, context: XmlContext): 128 | 192 | 256 {
  const value = unsignedAttribute(element, name, context);
  if (value !== 128 && value !== 192 && value !== 256) {
    if (value >= 8 && value % 8 === 0) throw unsupported();
    throw corrupt();
  }
  return value;
}

function hashAttribute(element: XmlElement, name: string): { algorithm: OfficeHashName; size: number } {
  const source = requiredAttribute(element, name);
  const hash = HASHES.get(source);
  if (!hash) throw unsupported();
  return { algorithm: hash.webCrypto, size: hash.size };
}

function collapseXmlWhitespace(value: string, context?: XmlContext): string {
  let start = 0;
  let end = value.length;
  while (start < end && isXmlSpaceCode(value.charCodeAt(start))) {
    context?.budget.tick();
    start += 1;
  }
  while (end > start && isXmlSpaceCode(value.charCodeAt(end - 1))) {
    context?.budget.tick();
    end -= 1;
  }
  return value.slice(start, end);
}

function isXmlWhitespace(value: string, context: XmlContext): boolean {
  for (let index = 0; index < value.length; index += 1) {
    context.budget.tick();
    if (!isXmlSpaceCode(value.charCodeAt(index))) return false;
  }
  return true;
}

function isXmlSpaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function decodeBase64(source: string, context: XmlContext, expectedLength: number): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let compactLength = 0;
  let padding = 0;
  let seenPadding = false;
  for (let index = 0; index < source.length; index += 1) {
    context.budget.tick();
    const code = source.charCodeAt(index);
    if (isXmlSpaceCode(code)) continue;
    compactLength += 1;
    if (code === 61) {
      seenPadding = true;
      padding += 1;
      if (padding > 2) throw corrupt();
    } else {
      if (seenPadding || alphabet.indexOf(source[index]!) < 0) throw corrupt();
    }
  }
  if (compactLength === 0 || compactLength % 4 !== 0 || padding > 2) throw corrupt();
  const decodedLength = (compactLength / 4) * 3 - padding;
  if (decodedLength !== expectedLength) throw corrupt();
  const output = new Uint8Array(decodedLength);
  let out = 0;
  let quartet: string[] = [];
  let values = [0, 0, 0, 0];
  let quartetsProcessed = 0;
  for (let index = 0; index < source.length; index += 1) {
    context.budget.tick();
    const char = source[index]!;
    const code = source.charCodeAt(index);
    if (isXmlSpaceCode(code)) continue;
    const position = quartet.length;
    quartet.push(char);
    values[position] = char === '=' ? 0 : alphabet.indexOf(char);
    if (quartet.length !== 4) continue;
    quartetsProcessed += 1;
    const last = quartetsProcessed === compactLength / 4;
    const hasPad2 = quartet[2] === '=';
    const hasPad3 = quartet[3] === '=';
    if (quartet[0] === '=' || quartet[1] === '=') throw corrupt();
    if (
      (!last && (hasPad2 || hasPad3)) ||
      (hasPad2 && !hasPad3) ||
      (hasPad2 && (values[1]! & 15) !== 0) ||
      (hasPad3 && !hasPad2 && (values[2]! & 3) !== 0)
    )
      throw corrupt();
    output[out++] = (values[0]! << 2) | (values[1]! >> 4);
    if (!hasPad2 && out < decodedLength) output[out++] = ((values[1]! & 15) << 4) | (values[2]! >> 2);
    if (!hasPad3 && out < decodedLength) output[out++] = ((values[2]! & 3) << 6) | values[3]!;
    quartet = [];
    values = [0, 0, 0, 0];
  }
  if (out !== decodedLength) throw corrupt();
  return output;
}

function roundToBlock(length: number): number {
  return Math.ceil(length / AES_BLOCK_SIZE) * AES_BLOCK_SIZE;
}

function hasBytes(bytes: Uint8Array, offset: number, length: number): boolean {
  return Number.isSafeInteger(length) && length >= 0 && offset >= 0 && length <= bytes.byteLength - offset;
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The EncryptionInfo stream is invalid.');
}

function unsupported(): EncryptedError {
  return new EncryptedError('unsupported-encryption');
}

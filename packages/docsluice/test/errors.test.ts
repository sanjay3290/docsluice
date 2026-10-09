import { describe, expect, it } from 'vitest';
import {
  AbortError,
  CorruptFileError,
  DocsluiceError,
  EncryptedError,
  LimitExceededError,
  TimeoutError,
  UnsupportedFormatError,
} from '../src/index.js';

describe('errors', () => {
  it('every error extends DocsluiceError and carries a stable code', () => {
    const cases: Array<[DocsluiceError, string]> = [
      [new UnsupportedFormatError('exe'), 'UNSUPPORTED_FORMAT'],
      [new EncryptedError('password-required'), 'ENCRYPTED'],
      [new CorruptFileError(), 'CORRUPT_FILE'],
      [new LimitExceededError('zipEntries', 10_000), 'LIMIT_EXCEEDED'],
      [new TimeoutError(60_000), 'TIMEOUT'],
      [new AbortError(), 'ABORTED'],
    ];
    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(DocsluiceError);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe(code);
      expect(error.name).toBe(error.constructor.name);
    }
  });

  it('LimitExceededError carries the limit name and value', () => {
    const error = new LimitExceededError('cells', 2_000_000);
    expect(error.limit).toBe('cells');
    expect(error.value).toBe(2_000_000);
  });
});

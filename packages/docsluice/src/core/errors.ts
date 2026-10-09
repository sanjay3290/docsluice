/**
 * Error classes (PRD section 12). Codes are part of the public contract.
 * Rule: a message never includes document content. Callers log these messages.
 */

import type { WarningCode } from './model.js';

export type ErrorCode =
  | 'UNSUPPORTED_FORMAT'
  | 'ENCRYPTED'
  | 'CORRUPT_FILE'
  | 'LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'STRICT_WARNING';

export class DocsluiceError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnsupportedFormatError extends DocsluiceError {
  readonly format: string;

  constructor(format: string) {
    super('UNSUPPORTED_FORMAT', `No reader for format "${format}".`);
    this.format = format;
  }
}

export class EncryptedError extends DocsluiceError {
  readonly reason: 'password-required' | 'wrong-password' | 'unsupported-encryption';

  constructor(reason: EncryptedError['reason']) {
    super('ENCRYPTED', `The file is encrypted (${reason}).`);
    this.reason = reason;
  }
}

export class CorruptFileError extends DocsluiceError {
  constructor(message = 'Nothing could be read from the file.', options?: { cause?: unknown }) {
    super('CORRUPT_FILE', message, options);
  }
}

export class LimitExceededError extends DocsluiceError {
  readonly limit: string;
  readonly value: number;

  constructor(limit: string, value: number) {
    super('LIMIT_EXCEEDED', `Limit "${limit}" (${value}) was exceeded.`);
    this.limit = limit;
    this.value = value;
  }
}

export class TimeoutError extends DocsluiceError {
  readonly timeMs: number;

  constructor(timeMs: number) {
    super('TIMEOUT', `Extraction took longer than ${timeMs} ms.`);
    this.timeMs = timeMs;
  }
}

export class AbortError extends DocsluiceError {
  constructor(options?: { cause?: unknown }) {
    super('ABORTED', 'Extraction was aborted by the caller.', options);
  }
}

/** A warning selected by the caller's strict policy stopped extraction. */
export class StrictModeError extends DocsluiceError {
  readonly warningCode: WarningCode;

  constructor(warningCode: WarningCode) {
    super('STRICT_WARNING', `Warning "${warningCode}" is forbidden by strict mode.`);
    this.warningCode = warningCode;
  }
}

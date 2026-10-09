import {
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
  UnsupportedFormatError,
} from '../../core/errors.js';
import type { Budget } from '../../core/budget.js';

const BIFF_RECORD_HEADER_SIZE = 4;
const MAX_BIFF_RECORD_DATA_SIZE = 8_224;
export const MAX_BIFF_RECORDS = 1_000_000;
const BIFF8_BOF = 0x0809;
const BOF_IDS = new Set([0x0009, 0x0209, 0x0409, BIFF8_BOF]);
const FILEPASS = 0x002f;
const VALID_BOF_TYPES = new Set([0x0005, 0x0010, 0x0020, 0x0040]);

export interface BiffRecord {
  /** BIFF record type from its two-byte little-endian header. */
  readonly id: number;
  /** Byte offset of the four-byte record header in the workbook stream. */
  readonly offset: number;
  /** View of this record's payload; no payload-sized copy is made. */
  readonly data: Uint8Array;
}

/**
 * Iterate a BIFF workbook stream. The first record must be a BIFF8 BOF and
 * every record must fit both the source bytes and the MS-XLS record-size cap.
 * FILEPASS is reported before any following encrypted records are interpreted.
 */
export function* iterateBiffRecords(bytes: Uint8Array, budget: Budget): Generator<BiffRecord> {
  budget.tick();
  if (bytes.byteLength < BIFF_RECORD_HEADER_SIZE) throw corrupt();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let first = true;
  let recordsYielded = 0;

  while (offset < bytes.byteLength) {
    budget.tick();
    if (recordsYielded >= MAX_BIFF_RECORDS) throw new LimitExceededError('xlsRecords', MAX_BIFF_RECORDS);
    const remaining = bytes.byteLength - offset;
    if (remaining < BIFF_RECORD_HEADER_SIZE) throw corrupt();

    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (length > MAX_BIFF_RECORD_DATA_SIZE || length > remaining - BIFF_RECORD_HEADER_SIZE) throw corrupt();
    const dataStart = offset + BIFF_RECORD_HEADER_SIZE;
    const data = bytes.subarray(dataStart, dataStart + length);

    if (first) {
      if (!BOF_IDS.has(id)) throw corrupt();
      validateBof(id, data, budget);
      first = false;
    } else if (BOF_IDS.has(id)) {
      validateBof(id, data, budget);
    }

    if (id === FILEPASS) throw new EncryptedError('unsupported-encryption');
    recordsYielded += 1;
    yield { id, offset, data };
    offset = dataStart + length;
  }

  if (first) throw corrupt();
}

function validateBof(id: number, data: Uint8Array, budget: Budget): void {
  budget.tick();
  if (data.byteLength < 2) throw corrupt();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const version = view.getUint16(0, true);
  if (id !== BIFF8_BOF || version !== 0x0600) {
    if (version < 0x0600) {
      budget.warnings.add({
        code: 'UNREADABLE_PART',
        message: 'BIFF5 and older XLS workbooks are unsupported.',
      });
    }
    throw new UnsupportedFormatError('xls');
  }
  if (data.byteLength !== 16 || !VALID_BOF_TYPES.has(view.getUint16(2, true))) throw corrupt();
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The XLS workbook record stream is corrupt.');
}

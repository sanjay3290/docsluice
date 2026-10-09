import { AbortError, CorruptFileError, TimeoutError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import { iterXlsbRecords, XlsbCursor } from '../src/readers/xlsb/records.js';

/** Fuzz harness entry point for XLSB record headers and bounded common fields. */
export function fuzzXlsbRecords(input: Uint8Array): void {
  const bytes = input.subarray(0, 1_000_000);
  const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 1_000 });
  try {
    for (const record of iterXlsbRecords(bytes, budget)) {
      budget.tick();
      const cursor = new XlsbCursor(record.data, budget);
      switch ((input[0] ?? 0) % 6) {
        case 0:
          cursor.readU8();
          break;
        case 1:
          cursor.readU16();
          break;
        case 2:
          cursor.readU32();
          break;
        case 3:
          cursor.readF64();
          break;
        case 4:
          cursor.readWideString();
          break;
        default:
          cursor.readNullableWideString();
          break;
      }
    }
  } catch (error) {
    if (error instanceof CorruptFileError || error instanceof AbortError || error instanceof TimeoutError)
      return;
    throw error;
  }
}

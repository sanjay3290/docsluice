import { CorruptFileError, LimitExceededError } from '../../core/errors.js';
import type { Budget } from '../../core/budget.js';

const MAX_SST_STRINGS = 100_000;
const MAX_SST_CHARACTERS = 20_000_000;
const STRING_CHUNK_SIZE = 4_096;
const FLAG_HIGH_BYTE = 0x01;
const FLAG_EXTENDED = 0x04;
const FLAG_RICH = 0x08;
const FORMAT_RUN_SIZE = 4;

/**
 * Decode the string array in an SST record and its immediately following
 * CONTINUE payloads. Only a continuation inside character data consumes the
 * continuation option byte; headers, format runs, and ExtRst bytes do not.
 */
export function readBiff8Sst(
  sstData: Uint8Array,
  continueBodies: readonly Uint8Array[],
  budget: Budget,
): string[] {
  budget.tick();
  const cursor = new SstCursor(sstData, continueBodies, budget);
  if (sstData.byteLength < 8) throw corrupt();
  const totalReferences = cursor.readInt32();
  const uniqueCount = cursor.readInt32();
  if (totalReferences < 0 || uniqueCount < 0 || uniqueCount > totalReferences) throw corrupt();
  if (uniqueCount > MAX_SST_STRINGS) throw new LimitExceededError('xlsSstStrings', MAX_SST_STRINGS);

  const strings: string[] = [];
  let totalCharacters = 0;
  for (let index = 0; index < uniqueCount; index += 1) {
    budget.tick();
    const characterCount = cursor.readUint16();
    const flags = cursor.readUint8();
    if ((flags & ~0x0d) !== 0) throw corrupt();
    const rich = (flags & FLAG_RICH) !== 0;
    const extended = (flags & FLAG_EXTENDED) !== 0;
    const runCount = rich ? cursor.readUint16() : 0;
    const extendedSize = extended ? cursor.readInt32() : 0;
    if (extendedSize < 0) throw corrupt();
    if (characterCount > MAX_SST_CHARACTERS - totalCharacters)
      throw new LimitExceededError('xlsSstCharacters', MAX_SST_CHARACTERS);

    const value = cursor.readCharacters(characterCount, (flags & FLAG_HIGH_BYTE) !== 0);
    cursor.skip(runCount * FORMAT_RUN_SIZE);
    cursor.skip(extendedSize);
    totalCharacters += characterCount;
    strings.push(value);
  }
  cursor.assertConsumed();
  return strings;
}

class SstCursor {
  readonly #base: Uint8Array;
  readonly #continues: readonly Uint8Array[];
  readonly #budget: Budget;
  #segmentIndex = 0;
  #offset = 0;

  constructor(base: Uint8Array, continues: readonly Uint8Array[], budget: Budget) {
    this.#base = base;
    this.#continues = continues;
    this.#budget = budget;
  }

  readUint8(): number {
    this.#budget.tick();
    this.#advanceEmptySegments();
    const segment = this.#segmentAt(this.#segmentIndex);
    if (!segment || this.#offset >= segment.byteLength) throw corrupt();
    const value = segment[this.#offset]!;
    this.#offset += 1;
    return value;
  }

  readUint16(): number {
    const low = this.readUint8();
    const high = this.readUint8();
    return low | (high << 8);
  }

  readInt32(): number {
    const byte0 = this.readUint8();
    const byte1 = this.readUint8();
    const byte2 = this.readUint8();
    const byte3 = this.readUint8();
    return byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24) | 0;
  }

  readCharacters(count: number, initialHighByte: boolean): string {
    let highByte = initialHighByte;
    let remaining = count;
    const output: string[] = [];
    let codes: number[] = [];

    while (remaining > 0) {
      this.#budget.tick();
      let segment = this.#segmentAt(this.#segmentIndex);
      if (!segment) throw corrupt();
      if (this.#offset === segment.byteLength) {
        if (!this.#advanceForCharacterContinuation()) throw corrupt();
        const option = this.readContinuationOption();
        if ((option & ~FLAG_HIGH_BYTE) !== 0) throw corrupt();
        highByte = (option & FLAG_HIGH_BYTE) !== 0;
        segment = this.#segmentAt(this.#segmentIndex);
        if (!segment) throw corrupt();
      }

      const width = highByte ? 2 : 1;
      const available = segment.byteLength - this.#offset;
      if (available < width) throw corrupt();
      const low = segment[this.#offset]!;
      const code = highByte ? low | (segment[this.#offset + 1]! << 8) : low;
      this.#offset += width;
      codes.push(code);
      remaining -= 1;

      if (codes.length === STRING_CHUNK_SIZE) {
        output.push(String.fromCharCode(...codes));
        codes = [];
      }
    }

    if (codes.length > 0) output.push(String.fromCharCode(...codes));
    return output.join('');
  }

  skip(byteCount: number): void {
    let remaining = byteCount;
    while (remaining > 0) {
      this.#budget.tick();
      this.#advanceEmptySegments();
      const segment = this.#segmentAt(this.#segmentIndex);
      if (!segment) throw corrupt();
      const available = segment.byteLength - this.#offset;
      if (available <= 0) throw corrupt();
      const consumed = Math.min(available, remaining);
      this.#offset += consumed;
      remaining -= consumed;
    }
  }

  assertConsumed(): void {
    this.#budget.tick();
    for (let index = this.#segmentIndex; index < this.#segmentCount; index += 1) {
      this.#budget.tick();
      const segment = this.#segmentAt(index)!;
      const start = index === this.#segmentIndex ? this.#offset : 0;
      if (start < segment.byteLength) throw corrupt();
    }
  }

  #advanceEmptySegments(): void {
    while (this.#segmentIndex < this.#segmentCount) {
      this.#budget.tick();
      const segment = this.#segmentAt(this.#segmentIndex)!;
      if (this.#offset < segment.byteLength) return;
      this.#segmentIndex += 1;
      this.#offset = 0;
    }
  }

  #advanceForCharacterContinuation(): boolean {
    const nextIndex = this.#segmentIndex + 1;
    if (nextIndex >= this.#segmentCount) return false;
    this.#budget.tick();
    const next = this.#segmentAt(nextIndex)!;
    if (next.byteLength === 0) throw corrupt();
    this.#segmentIndex = nextIndex;
    this.#offset = 0;
    return true;
  }

  readContinuationOption(): number {
    const segment = this.#segmentAt(this.#segmentIndex);
    if (!segment || segment.byteLength === 0) throw corrupt();
    this.#budget.tick();
    const value = segment[this.#offset]!;
    this.#offset += 1;
    return value;
  }

  get #segmentCount(): number {
    return this.#continues.length + 1;
  }

  #segmentAt(index: number): Uint8Array | undefined {
    return index === 0 ? this.#base : this.#continues[index - 1];
  }
}

function corrupt(): CorruptFileError {
  return new CorruptFileError('The XLS shared string table is corrupt.');
}

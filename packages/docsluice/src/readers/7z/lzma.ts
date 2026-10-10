import type { Budget } from '../../core/budget.js';
import { CorruptFileError } from '../../core/errors.js';

// An LZMA decoder written from the LZMA specification (Igor Pavlov, public domain), for the
// compressed headers of 7z archives. It decodes into one buffer of the declared size, which is
// also the dictionary window, so no distance can reach outside the bytes already written.

const NUM_STATES = 12;
const POS_STATES_MAX = 16;
const END_POS_MODEL_INDEX = 14;
const NUM_FULL_DISTANCES = 128;
const LEN_TO_POS_STATES = 4;
const MATCH_MIN_LEN = 2;
const PROB_INIT = 1024;

function corrupt(): CorruptFileError {
  return new CorruptFileError('The 7z header stream is malformed.');
}

class RangeDecoder {
  #input: Uint8Array;
  #offset: number;
  #range = 0xffff_ffff;
  #code = 0;
  overrun = false;

  constructor(input: Uint8Array) {
    this.#input = input;
    if (input.length < 5 || input[0] !== 0) throw corrupt();
    this.#offset = 1;
    for (let index = 0; index < 4; index++) this.#code = this.#code * 256 + this.#next();
    if (this.#code >= this.#range) throw corrupt();
  }

  #next(): number {
    if (this.#offset >= this.#input.length) {
      this.overrun = true;
      return 0;
    }
    return this.#input[this.#offset++]!;
  }

  #normalize(): void {
    if (this.#range < 0x0100_0000) {
      this.#range *= 256;
      this.#code = this.#code * 256 + this.#next();
    }
  }

  bit(probs: Uint16Array, index: number): number {
    const probability = probs[index]!;
    const bound = Math.floor(this.#range / 2048) * probability;
    let bit: number;
    if (this.#code < bound) {
      this.#range = bound;
      probs[index] = probability + ((2048 - probability) >>> 5);
      bit = 0;
    } else {
      this.#range -= bound;
      this.#code -= bound;
      probs[index] = probability - (probability >>> 5);
      bit = 1;
    }
    this.#normalize();
    return bit;
  }

  direct(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index++) {
      this.#range = Math.floor(this.#range / 2);
      let bit = 0;
      if (this.#code >= this.#range) {
        this.#code -= this.#range;
        bit = 1;
      }
      this.#normalize();
      result = result * 2 + bit;
    }
    return result;
  }

  tree(probs: Uint16Array, base: number, bits: number): number {
    let symbol = 1;
    for (let index = 0; index < bits; index++) symbol = symbol * 2 + this.bit(probs, base + symbol);
    return symbol - (1 << bits);
  }

  reverseTree(probs: Uint16Array, base: number, bits: number): number {
    let symbol = 1;
    let result = 0;
    for (let index = 0; index < bits; index++) {
      const bit = this.bit(probs, base + symbol);
      symbol = symbol * 2 + bit;
      result |= bit << index;
    }
    return result;
  }
}

/** Length decoder: choice bits, then low, mid or high bit trees. */
class LengthDecoder {
  #probs = new Uint16Array(2 + POS_STATES_MAX * 8 * 2 + 256).fill(PROB_INIT);

  decode(range: RangeDecoder, posState: number): number {
    if (range.bit(this.#probs, 0) === 0) return range.tree(this.#probs, 2 + posState * 8, 3);
    if (range.bit(this.#probs, 1) === 0)
      return 8 + range.tree(this.#probs, 2 + (POS_STATES_MAX + posState) * 8, 3);
    return 16 + range.tree(this.#probs, 2 + POS_STATES_MAX * 16, 8);
  }
}

/**
 * Decode an LZMA stream (`properties` is the 5-byte coder property block) into exactly
 * `outputSize` bytes. The caller charges `outputSize` to the budget first. Malformed data, a
 * distance before the start of the output or input that runs out fail with `CORRUPT_FILE`.
 */
export function decodeLzma(
  input: Uint8Array,
  properties: Uint8Array,
  outputSize: number,
  budget: Budget,
): Uint8Array {
  if (properties.length < 5 || properties[0]! >= 9 * 5 * 5) throw corrupt();
  let value = properties[0]!;
  const lc = value % 9;
  value = Math.floor(value / 9);
  const lp = value % 5;
  // Below 225, pb is at most 4.
  const pb = Math.floor(value / 5);

  const output = new Uint8Array(outputSize);
  const range = new RangeDecoder(input);
  const literals = new Uint16Array(0x300 << (lc + lp)).fill(PROB_INIT);
  const isMatch = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
  const isRep = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG0 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG1 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRepG2 = new Uint16Array(NUM_STATES).fill(PROB_INIT);
  const isRep0Long = new Uint16Array(NUM_STATES << 4).fill(PROB_INIT);
  const posSlots = new Uint16Array(LEN_TO_POS_STATES << 6).fill(PROB_INIT);
  const posDecoders = new Uint16Array(1 + NUM_FULL_DISTANCES - END_POS_MODEL_INDEX).fill(PROB_INIT);
  const align = new Uint16Array(16).fill(PROB_INIT);
  const lengths = new LengthDecoder();
  const repLengths = new LengthDecoder();
  const pbMask = (1 << pb) - 1;
  const lpMask = (1 << lp) - 1;

  let state = 0;
  let rep0 = 0;
  let rep1 = 0;
  let rep2 = 0;
  let rep3 = 0;
  let position = 0;
  while (position < outputSize) {
    budget.tick();
    const posState = position & pbMask;
    if (range.bit(isMatch, (state << 4) + posState) === 0) {
      const previous = position > 0 ? output[position - 1]! : 0;
      const base = 0x300 * (((position & lpMask) << lc) + (previous >>> (8 - lc)));
      let symbol = 1;
      if (state >= 7) {
        let matchByte = output[position - rep0 - 1]!;
        while (symbol < 0x100) {
          const matchBit = (matchByte >>> 7) & 1;
          matchByte <<= 1;
          const bit = range.bit(literals, base + ((1 + matchBit) << 8) + symbol);
          symbol = (symbol << 1) | bit;
          if (matchBit !== bit) break;
        }
      }
      while (symbol < 0x100) symbol = (symbol << 1) | range.bit(literals, base + symbol);
      output[position++] = symbol & 0xff;
      state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
      continue;
    }
    let length: number;
    if (range.bit(isRep, state) === 1) {
      if (position === 0) throw corrupt();
      if (range.bit(isRepG0, state) === 0) {
        if (range.bit(isRep0Long, (state << 4) + posState) === 0) {
          state = state < 7 ? 9 : 11;
          output[position] = output[position - rep0 - 1]!;
          position++;
          continue;
        }
      } else {
        let distance: number;
        if (range.bit(isRepG1, state) === 0) {
          distance = rep1;
        } else {
          if (range.bit(isRepG2, state) === 0) {
            distance = rep2;
          } else {
            distance = rep3;
            rep3 = rep2;
          }
          rep2 = rep1;
        }
        rep1 = rep0;
        rep0 = distance;
      }
      length = repLengths.decode(range, posState);
      state = state < 7 ? 8 : 11;
    } else {
      rep3 = rep2;
      rep2 = rep1;
      rep1 = rep0;
      length = lengths.decode(range, posState);
      state = state < 7 ? 7 : 10;
      const lenState = Math.min(length, LEN_TO_POS_STATES - 1);
      const slot = range.tree(posSlots, lenState << 6, 6);
      if (slot < 4) {
        rep0 = slot;
      } else {
        const directBits = (slot >>> 1) - 1;
        let distance = (2 | (slot & 1)) * 2 ** directBits;
        if (slot < END_POS_MODEL_INDEX) {
          distance += range.reverseTree(posDecoders, distance - slot, directBits);
        } else {
          distance += range.direct(directBits - 4) * 16;
          distance += range.reverseTree(align, 0, 4);
        }
        rep0 = distance;
      }
      // The end marker: allowed only once the declared size is reached, which the loop prevents.
      if (rep0 === 0xffff_ffff) break;
    }
    if (rep0 >= position) throw corrupt();
    const end = Math.min(outputSize, position + length + MATCH_MIN_LEN);
    for (; position < end; position++) output[position] = output[position - rep0 - 1]!;
  }
  if (position !== outputSize || range.overrun) throw corrupt();
  return output;
}

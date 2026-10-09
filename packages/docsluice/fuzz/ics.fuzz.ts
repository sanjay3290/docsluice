import { fuzzTextReader } from './text-family.js';
import reader from '../src/readers/ics/index.js';

export function fuzzIcs(input: Uint8Array): Promise<void> {
  return fuzzTextReader(reader, input);
}

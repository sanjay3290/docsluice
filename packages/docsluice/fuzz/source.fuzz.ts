import { fuzzTextReader } from './text-family.js';
import reader from '../src/readers/source/index.js';

export function fuzzSource(input: Uint8Array): Promise<void> {
  return fuzzTextReader(reader, input, 'fuzz.ts');
}

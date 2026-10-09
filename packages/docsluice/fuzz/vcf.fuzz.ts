import { fuzzTextReader } from './text-family.js';
import reader from '../src/readers/vcf/index.js';

export function fuzzVcf(input: Uint8Array): Promise<void> {
  return fuzzTextReader(reader, input);
}

import { fuzzTextReader } from './text-family.js';
import reader from '../src/readers/ndjson/index.js';

export function fuzzNdjson(input: Uint8Array): Promise<void> {
  return fuzzTextReader(reader, input);
}

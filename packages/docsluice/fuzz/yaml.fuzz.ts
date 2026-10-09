import { fuzzTextReader } from './text-family.js';
import reader from '../src/readers/yaml/index.js';

export function fuzzYaml(input: Uint8Array): Promise<void> {
  return fuzzTextReader(reader, input);
}

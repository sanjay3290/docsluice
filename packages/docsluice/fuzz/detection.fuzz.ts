import { decodeText, detectEncoding } from '../src/detect/encoding.js';
import { detectTextKindCandidates } from '../src/detect/text-kind.js';

/** Entry point for fuzz runners; malformed bytes and text must never escape as errors. */
export function fuzzDetection(input: Uint8Array): void {
  const sample = input.subarray(0, 8 * 1024);
  const detection = detectEncoding(sample);
  if (detection.isText && detection.encoding !== 'unsupported') {
    detectTextKindCandidates(decodeText(sample, detection.encoding));
  }
}

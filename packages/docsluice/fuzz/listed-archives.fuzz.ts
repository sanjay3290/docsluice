import { Budget } from '../src/core/budget.js';
import { DocsluiceError } from '../src/core/errors.js';
import { resolveLimits } from '../src/core/limits.js';
import { WarningSink } from '../src/core/warnings.js';
import { list7z, SIGNATURE } from '../src/readers/7z/archive.js';
import { decodeLzma } from '../src/readers/7z/lzma.js';
import { listRar, RAR4_SIGNATURE, RAR5_SIGNATURE } from '../src/readers/rar/archive.js';

const budget = () =>
  new Budget(resolveLimits({ totalUncompressedBytes: 4_000_000, timeMs: 1_000 }), {
    warnings: new WarningSink(),
  });

function run(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    // Malformed headers and resource limits are ordinary outcomes; anything else is a finding.
    if (!(error instanceof DocsluiceError)) throw error;
  }
}

function withPrefix(prefix: readonly number[], body: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(prefix.length + body.length);
  bytes.set(prefix);
  bytes.set(body, prefix.length);
  return bytes;
}

/**
 * The 7z and RAR listers (ADR 0014) and the LZMA decoder. Inputs without a signature are tried
 * under each signature, so mutations reach the header parsers.
 */
export function fuzzListedArchives(input: Uint8Array): void {
  const sample = input.subarray(0, 1_000_000);
  run(() => list7z(sample, budget()));
  run(() => listRar(sample, budget()));
  run(() => list7z(withPrefix(SIGNATURE, sample), budget()));
  run(() => listRar(withPrefix(RAR5_SIGNATURE, sample), budget()));
  run(() => listRar(withPrefix(RAR4_SIGNATURE, sample), budget()));
  // The first five bytes as LZMA properties, the rest as a stream with a bounded declared size.
  if (sample.length > 5) {
    const size = (sample[1]! | (sample[2]! << 8)) & 0xffff;
    run(() => decodeLzma(sample.subarray(5), sample.subarray(0, 5), size, budget()));
  }
}

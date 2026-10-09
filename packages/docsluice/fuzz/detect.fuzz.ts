import { sniffMagic } from '../src/detect/sniff.js';

/** A zero-dependency fuzz entry point for arbitrary detector input bytes. */
export function fuzzDetect(data: Uint8Array): void {
  const detected = sniffMagic(data);
  if (!Number.isFinite(detected.confidence) || detected.confidence < 0 || detected.confidence > 1) {
    throw new Error('detector returned invalid confidence');
  }
  if ((detected.kind === null) !== (detected.mimeType === null)) {
    throw new Error('detector kind and MIME type must be null together');
  }
}

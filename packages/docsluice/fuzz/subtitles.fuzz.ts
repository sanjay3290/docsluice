import { fuzzTextReader } from './text-family.js';
import { srt, vtt } from '../src/readers/subtitles/index.js';

export async function fuzzSubtitles(input: Uint8Array): Promise<void> {
  await fuzzTextReader(srt, input);
  await fuzzTextReader(vtt, input);
}

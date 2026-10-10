import type { Reader, ReadContext } from '../../core/reader.js';
import { parseMedia } from './parse.js';

/** Seconds with millisecond precision, as text. */
function seconds(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/**
 * Container metadata of an audio or video file as document metadata (#248): `title`, `authors`
 * (the artist; dropped with `metadata: false`) and `custom` pairs for album, date, genre, duration,
 * sample rate, channels, bits per sample, codecs and frame size. No blocks: nothing is decoded or
 * transcribed.
 */
async function readMedia(ctx: ReadContext): Promise<void> {
  await Promise.resolve();
  const info = parseMedia(ctx.bytes, ctx.budget);
  if (info.title !== undefined) ctx.out.setMetadata({ title: info.title });
  if (info.artist !== undefined) ctx.out.setMetadata({ authors: [info.artist] });
  const custom: Array<{ name: string; value: string }> = [];
  if (info.container !== undefined) custom.push({ name: 'container', value: info.container });
  if (info.album !== undefined) custom.push({ name: 'album', value: info.album });
  if (info.date !== undefined) custom.push({ name: 'date', value: info.date });
  if (info.genre !== undefined) custom.push({ name: 'genre', value: info.genre });
  if (info.durationSeconds !== undefined && Number.isFinite(info.durationSeconds))
    custom.push({ name: 'durationSeconds', value: seconds(info.durationSeconds) });
  if (info.sampleRate) custom.push({ name: 'sampleRate', value: String(info.sampleRate) });
  if (info.channels) custom.push({ name: 'channels', value: String(info.channels) });
  if (info.bitsPerSample) custom.push({ name: 'bitsPerSample', value: String(info.bitsPerSample) });
  if (info.codecs.length > 0) custom.push({ name: 'codecs', value: info.codecs.join(', ') });
  if (info.width && info.height) {
    custom.push({ name: 'width', value: String(info.width) });
    custom.push({ name: 'height', value: String(info.height) });
  }
  if (custom.length > 0) ctx.out.setMetadata({ custom });
}

/** Reader for detected audio files: MP3, FLAC, Ogg, Opus, WAV, M4A (#248). */
export const audioReader: Reader = { id: 'audio', mimeTypes: ['audio/mpeg'], read: readMedia };

/** Reader for detected video files: MP4 and QuickTime (#248). */
export const videoReader: Reader = { id: 'video', mimeTypes: ['video/mp4'], read: readMedia };

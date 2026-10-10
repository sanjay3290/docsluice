import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';

// Synthetic audio and video corpus files (CC0-1.0) made with ffmpeg (6.1, with libmp3lame,
// libvorbis, libopus and libx264): one second of a sine tone (and a 16x16 test pattern for video)
// with the same tags in each container. Usage: node scripts/corpus/make-media.mjs [ffmpeg]
const ffmpeg = process.argv[2] ?? 'ffmpeg';
const directory = new URL('../../corpus/media/', import.meta.url);
await mkdir(directory, { recursive: true });
const tags = ['title=Tide Gauge Tone', 'artist=Casey Example', 'album=Field Recordings', 'date=2026', 'genre=Ambient'].flatMap(
  (tag) => ['-metadata', tag],
);
const tone = ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=44100'];
const exact = ['-fflags', '+bitexact', '-flags:a', '+bitexact', '-flags:v', '+bitexact', '-map_metadata', '-1'];
const jobs = [
  ['tone.mp3', [...tone, ...exact, '-c:a', 'libmp3lame', '-b:a', '32k', '-id3v2_version', '3', ...tags]],
  ['tone.flac', [...tone, ...exact, '-c:a', 'flac', ...tags]],
  ['tone.ogg', [...tone, ...exact, '-c:a', 'libvorbis', '-q:a', '0', ...tags]],
  ['tone.opus', [...tone, ...exact, '-c:a', 'libopus', '-b:a', '16k', ...tags]],
  ['tone.wav', [...tone, ...exact, '-c:a', 'pcm_s16le', '-ar', '8000', ...tags]],
  ['tone.m4a', [...tone, ...exact, '-c:a', 'aac', '-b:a', '24k', ...tags]],
  [
    'pattern.mp4',
    [
      '-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=5:duration=1',
      ...tone, ...exact, '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '24k', ...tags,
    ],
  ],
];
for (const [name, args] of jobs) {
  const target = fileURLToPath(new URL(name, directory));
  const result = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args, target]);
  if (result.status !== 0) throw new Error(`ffmpeg failed for ${name}: ${result.stderr}`);
  await writeFile(
    `${target}.license`,
    `SPDX-License-Identifier: CC0-1.0\nSource: made for docsluice with ffmpeg by scripts/corpus/make-media.mjs\nRequirements: IN-4\nNotes: synthetic one-second tone (and test pattern) with title, artist, album, date and genre tags (#248).\n`,
  );
}

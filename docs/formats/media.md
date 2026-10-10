# Audio and video

The media reader (`docsluice/media`) reads the container metadata of audio and video files detected from their signatures: the `audio` format for MP3, FLAC, Ogg (Vorbis, Opus), WAV and Apple's audio-only MP4 brands (M4A, M4B, M4P), and the `video` format for MP4 and QuickTime. It gives no text and no blocks: nothing is decoded or transcribed (#248).

## Metadata

| Field | Source |
|-------|--------|
| `metadata.title` | ID3v2 `TIT2`/`TT2`, ID3v1, Vorbis comment `TITLE`, WAV `INAM`, MP4 `©nam` |
| `metadata.authors` | the artist: ID3v2 `TPE1`/`TP1`, ID3v1, `ARTIST`, `IART`, `©ART` |
| `custom` `album`, `date`, `genre` | ID3v2 `TALB`, `TDRC`/`TYER`, `TCON`; ID3v1; `ALBUM`, `DATE`, `GENRE`; `IPRD`, `ICRD`, `IGNR`; `©alb`, `©day`, `©gen` |
| `custom` `container` | `mp3`, `flac`, `ogg`, `wav` or `mp4` (QuickTime included) |
| `custom` `durationSeconds` | FLAC `STREAMINFO` samples, the last Ogg page's granule position (less the Opus pre-skip), WAV `data` size over the byte rate, MP4 `mvhd`; rounded to milliseconds |
| `custom` `sampleRate`, `channels`, `bitsPerSample` | FLAC `STREAMINFO`, the Vorbis or Opus identification header, WAV `fmt ` |
| `custom` `codecs` | `flac`, `vorbis`, `opus`, `pcm`, `pcm-float`, `wav-<format tag>`, or each MP4 track's sample entry type (`avc1`, `mp4a`, ...) |
| `custom` `width`, `height` | the first MP4 visual sample entry (`avc1`, `avc3`, `hvc1`, `hev1`, `mp4v`, `vp09`, `av01`) |

ID3v2 tags come first and ID3v1 fills only what they lack. Tag values have NUL separators turned into `, `, control characters into spaces, and are cut at 1,024 characters. `metadata: false` drops the artist with the other personal metadata (PRD section 15).

## Safety

- Nothing is decoded: only tag frames, metadata blocks, Ogg header packets, RIFF chunks and MP4 boxes are read.
- Every frame, block, chunk, page and box size is checked against the bytes present; a size lie stops that walk and keeps what was read. The reader adds no warning for it.
- MP4 boxes are walked with an explicit stack and stop at the `blockDepth` limit. An Ogg header packet over 1 MB is not assembled, and the last page is searched for only in the final 64 KiB.
- Every loop ticks the shared budget, so the time limit applies.

Not read: MP3 duration (it needs a frame scan or a Xing header), ID3v2 tags with unsynchronisation, ID3v2 frames other than text frames (comments, pictures, lyrics), Matroska and WebM (detected as `video`, no metadata), raw AAC, AIFF, and chapters or subtitle tracks. Transcription is out of scope.

## Corpus and generators

`scripts/corpus/make-media.mjs` makes the one-second `corpus/media` files with ffmpeg: a sine tone as MP3, FLAC, Ogg Vorbis, Opus, WAV and M4A, and an H.264 test pattern as MP4, each with fictional tags. `scripts/hostile/generate-media.mjs` writes `hostile/media`: 100,000 nested MP4 boxes, box, frame, block and chunk size lies, an Ogg segment table past the data, an endless continued Ogg packet and a flood of Vorbis comments. The fuzz target is `media`.

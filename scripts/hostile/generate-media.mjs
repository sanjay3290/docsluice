import { mkdir, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';

// Hostile audio and video headers (#248): MP4 boxes nested far past the depth limit, a box whose
// size points back at itself, an Ogg page whose segment table runs past the data, an ID3v2 frame
// size lie, a FLAC metadata block size lie, a WAV chunk size lie and a flood of Vorbis comments.
// docsluice reads container metadata only; nothing is decoded.
const directory = new URL('../../hostile/media/', import.meta.url);
await mkdir(directory, { recursive: true });

const le16 = (value) => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
const be16 = (value) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value) => [(value >>> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const box = (type, body) => [...be32(8 + body.length), ...ascii(type), ...body];
const ftyp = box('ftyp', [...ascii('isom'), ...be32(0x200), ...ascii('isom')]);

/** `depth` nested `moov` boxes, built inside out without recursion. */
function deepMoov(depth) {
  const bytes = new Uint8Array(ftyp.length + depth * 8);
  bytes.set(ftyp, 0);
  for (let level = 0; level < depth; level++) {
    const at = ftyp.length + level * 8;
    bytes.set([...be32((depth - level) * 8), ...ascii('moov')], at);
  }
  return bytes;
}

/** A Vorbis comment block with `count` short comments. */
function vorbisComments(count) {
  const out = [...le32(4), ...ascii('test'), ...le32(count)];
  for (let index = 0; index < count; index++) out.push(...le32(7), ...ascii('TITLE=x'));
  return out;
}

const files = new Map([
  // 100,000 nested `moov` boxes: the walker stops at the block depth limit.
  ['mp4-deep-boxes.mp4', deepMoov(100_000)],
  // A `moov` box whose 64-bit size is zero-length and a box claiming four gigabytes.
  [
    'mp4-size-lie.mp4',
    Uint8Array.from([...ftyp, ...be32(1), ...ascii('moov'), ...be32(0), ...be32(0), ...be32(0xfffffff0), ...ascii('mvhd'), 0, 0]),
  ],
  // An `stsd` box whose sample entry is cut short, and a `meta` box with no children.
  [
    'mp4-truncated-stsd.mp4',
    Uint8Array.from([
      ...ftyp,
      ...box('moov', [...box('trak', [...box('mdia', [...box('minf', [...box('stbl', [...box('stsd', [0, 0, 0, 0, ...be32(1), ...be32(86), ...ascii('avc1')])])])])]), ...box('meta', [0, 0, 0, 0])]),
    ]),
  ],
  // An Ogg page whose segment table claims 255 segments of 255 bytes in a 40-byte file.
  ['ogg-segment-lie.ogg', Uint8Array.from([...ascii('OggS'), 0, 2, ...new Array(8).fill(0), ...le32(1), ...le32(0), ...le32(0), 255, ...new Array(8).fill(255)])],
  // An Ogg Vorbis stream whose identification packet spans 4,000 pages of continued 255-byte segments.
  [
    'ogg-endless-packet.ogg',
    (() => {
      const page = [...ascii('OggS'), 0, 1, ...new Array(8).fill(0), ...le32(7), ...le32(0), ...le32(0), 4, 255, 255, 255, 255];
      const out = [];
      for (let index = 0; index < 4_000; index++) out.push(...page, ...new Array(1020).fill(0x41));
      return Uint8Array.from(out);
    })(),
  ],
  // An ID3v2.3 tag whose frame claims more bytes than the tag holds.
  ['id3-frame-lie.mp3', Uint8Array.from([...ascii('ID3'), 3, 0, 0, 0, 0, 0, 30, ...ascii('TIT2'), ...be32(0x7fffffff), 0, 0, 0, ...ascii('title'), 0xff, 0xfb, 0x90, 0x00])],
  // An ID3v2.4 tag with an extended header whose size runs past the tag.
  ['id3-extended-lie.mp3', Uint8Array.from([...ascii('ID3'), 4, 0, 0x40, 0, 0, 0, 20, 0x7f, 0x7f, 0x7f, 0x7f, ...new Array(16).fill(0)])],
  // A FLAC STREAMINFO block claiming 16 MB, then nothing.
  ['flac-block-lie.flac', Uint8Array.from([...ascii('fLaC'), 0x00, 0xff, 0xff, 0xff, ...new Array(18).fill(0)])],
  // A FLAC VORBIS_COMMENT block with 50,000 comments.
  [
    'flac-comment-flood.flac',
    (() => {
      const comments = vorbisComments(50_000);
      return Uint8Array.from([...ascii('fLaC'), 0x84, (comments.length >> 16) & 0xff, ...be16(comments.length & 0xffff), ...comments]);
    })(),
  ],
  // A WAV whose `LIST` chunk claims four gigabytes and holds an INFO item that lies about its length.
  [
    'wav-chunk-lie.wav',
    Uint8Array.from([
      ...ascii('RIFF'),
      ...le32(60),
      ...ascii('WAVE'),
      ...ascii('fmt '),
      ...le32(16),
      ...le16(1),
      ...le16(2),
      ...le32(44_100),
      ...le32(176_400),
      ...le16(4),
      ...le16(16),
      ...ascii('LIST'),
      ...le32(0xfffffff0),
      ...ascii('INFO'),
      ...ascii('INAM'),
      ...le32(0x7fffffff),
      ...ascii('title'),
    ]),
  ],
]);

for (const [name, bytes] of files) await writeFile(new URL(name, directory), bytes);

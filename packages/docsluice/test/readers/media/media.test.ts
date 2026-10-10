import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { parseMedia } from '../../../src/readers/media/parse.js';
import { fuzzMedia } from '../../../fuzz/media.fuzz.js';

const root = new URL('../../../../../', import.meta.url);
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, root)));
const parse = (bytes: number[] | Uint8Array) =>
  parseMedia(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), new Budget(DEFAULT_LIMITS));

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const utf8 = (text: string) => [...new TextEncoder().encode(text)];
const le16 = (value: number) => [value & 0xff, (value >> 8) & 0xff];
const le32 = (value: number) => [
  value & 0xff,
  (value >> 8) & 0xff,
  (value >> 16) & 0xff,
  (value >>> 24) & 0xff,
];
const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
const synchsafe = (value: number) => [
  (value >> 21) & 0x7f,
  (value >> 14) & 0x7f,
  (value >> 7) & 0x7f,
  value & 0x7f,
];
const box = (type: number[] | string, body: number[]) => [
  ...be32(8 + body.length),
  ...(typeof type === 'string' ? ascii(type) : type),
  ...body,
];

/** An ID3v2 tag of the given major version holding `frames`. */
function id3(major: number, frames: number[], flags = 0, prefix: number[] = []) {
  const body = [...prefix, ...frames];
  return [...ascii('ID3'), major, 0, flags, ...synchsafe(body.length), ...body];
}
function frame(major: number, id: string, data: number[]) {
  if (major === 2) return [...ascii(id), (data.length >> 16) & 0xff, ...be16(data.length & 0xffff), ...data];
  return [...ascii(id), ...(major === 4 ? synchsafe(data.length) : be32(data.length)), 0, 0, ...data];
}
function id3v1(title: string, artist: string, album: string, year: string) {
  const field = (text: string, length: number) => [
    ...ascii(text),
    ...new Array<number>(length - text.length).fill(0),
  ];
  return [
    ...ascii('TAG'),
    ...field(title, 30),
    ...field(artist, 30),
    ...field(album, 30),
    ...field(year, 4),
    ...new Array<number>(31).fill(0),
  ];
}
function vorbisComments(comments: string[]) {
  const out = [...le32(3), ...ascii('lib'), ...le32(comments.length)];
  for (const comment of comments) out.push(...le32(utf8(comment).length), ...utf8(comment));
  return out;
}
/** One Ogg page holding whole packets (each under 255 bytes). */
function oggPage(serial: number, granule: number, packets: number[][]) {
  return [
    ...ascii('OggS'),
    0,
    0,
    ...le32(granule),
    ...le32(0),
    ...le32(serial),
    ...le32(0),
    ...le32(0),
    packets.length,
    ...packets.map((packet) => packet.length),
    ...packets.flat(),
  ];
}

describe('media reader', () => {
  it.each([
    ['tone.mp3', 'audio', 'mp3'],
    ['tone.flac', 'audio', 'flac'],
    ['tone.ogg', 'audio', 'ogg'],
    ['tone.opus', 'audio', 'ogg'],
    ['tone.wav', 'audio', 'wav'],
    ['tone.m4a', 'audio', 'mp4'],
    ['pattern.mp4', 'video', 'mp4'],
  ])('%s gives its tags and stream facts and no blocks', async (name, format, container) => {
    const doc = await extract(read(`corpus/media/${name}`), { filename: name });
    expect(doc.format).toBe(format);
    expect(doc.blocks).toEqual([]);
    expect(doc.warnings).toEqual([]);
    expect(doc.metadata.title).toBe('Tide Gauge Tone');
    expect(doc.metadata.authors).toEqual(['Casey Example']);
    expect(doc.metadata.custom).toContainEqual({ name: 'container', value: container });
    if (name !== 'tone.mp3')
      expect(doc.metadata.custom).toContainEqual({ name: 'durationSeconds', value: '1' });
  });

  it('drops the artist with metadata: false', async () => {
    const doc = await extract(read('corpus/media/tone.flac'), { metadata: false });
    expect(doc.metadata.authors).toBeUndefined();
  });

  it('reads ID3v2.2, v2.3 and v2.4 text frames in every encoding', () => {
    const v22 = parse(
      id3(2, [...frame(2, 'TT2', [0, ...ascii('Old')]), ...frame(2, 'TP1', [0, ...ascii('Band')])]),
    );
    expect(v22).toMatchObject({ container: 'mp3', title: 'Old', artist: 'Band' });
    const v23 = parse(
      id3(3, [
        ...frame(3, 'TIT2', [1, 0xff, 0xfe, ...le16(0x48), ...le16(0x69)]),
        ...frame(3, 'TPE1', [1, 0xfe, 0xff, ...be16(0x41)]),
        ...frame(3, 'TALB', [2, ...be16(0x42)]),
        ...frame(3, 'TYER', [0, ...ascii('1999')]),
        ...frame(3, 'TCON', [3, ...utf8('Jazz')]),
        ...frame(3, 'COMM', [0, 1, 2, 3]),
      ]),
    );
    expect(v23).toMatchObject({ title: 'Hi', artist: 'A', album: 'B', date: '1999', genre: 'Jazz' });
    const v24 = parse(
      id3(4, [...frame(4, 'TDRC', [3, ...utf8('2024')]), ...frame(4, 'TIT2', [3, ...utf8('Now')])]),
    );
    expect(v24).toMatchObject({ date: '2024', title: 'Now' });
  });

  it('skips extended headers and ignores unsynchronised or unknown-version tags', () => {
    const v23 = parse(id3(3, frame(3, 'TIT2', [0, ...ascii('Ext')]), 0x40, [...be32(6), 0, 0, 0, 0, 0, 0]));
    expect(v23.title).toBe('Ext');
    const v24 = parse(id3(4, frame(4, 'TIT2', [0, ...ascii('Ext4')]), 0x40, [...synchsafe(6), 1, 0]));
    expect(v24.title).toBe('Ext4');
    expect(parse(id3(3, frame(3, 'TIT2', [0, ...ascii('U')]), 0x80)).title).toBeUndefined();
    expect(parse(id3(5, frame(3, 'TIT2', [0, ...ascii('V')]))).title).toBeUndefined();
    // Padding ends the frames; a zero-size frame stops the walk.
    expect(parse(id3(3, [...frame(3, 'TIT2', []), ...frame(3, 'TPE1', [0, 65])])).artist).toBeUndefined();
    expect(parse(id3(3, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).title).toBeUndefined();
  });

  it('reads ID3v1 after frame-sync MP3 data and fills only missing ID3v2 tags', () => {
    const plain = parse([0xff, 0xfb, 0x90, 0x00, ...id3v1('Tag One', 'Who', 'What', '2001')]);
    expect(plain).toMatchObject({
      container: 'mp3',
      title: 'Tag One',
      artist: 'Who',
      album: 'What',
      date: '2001',
    });
    const both = parse([...id3(3, frame(3, 'TIT2', [0, ...ascii('V2')])), ...id3v1('V1', 'Artist', '', '')]);
    expect(both).toMatchObject({ title: 'V2', artist: 'Artist' });
    expect(both.album).toBeUndefined();
  });

  it('cleans tag values: NULs separate, control characters become spaces, long values are cut', () => {
    const tags = parse(
      id3(3, [
        ...frame(3, 'TIT2', [0, ...ascii('A'), 0, ...ascii('B'), 0]),
        ...frame(3, 'TPE1', [0, ...ascii('x'), 0x07, ...ascii('y')]),
        ...frame(3, 'TALB', [0, ...new Array<number>(3_000).fill(0x61)]),
        ...frame(3, 'TCON', [0, 0, 0]),
      ]),
    );
    expect(tags.title).toBe('A, B');
    expect(tags.artist).toBe('x y');
    expect(tags.album).toHaveLength(1_024);
    expect(tags.genre).toBeUndefined();
  });

  it('reads FLAC STREAMINFO and Vorbis comments, and stops at a block size lie', () => {
    const streaminfo = [0, 0x10, 0, 0x10, 0, 0, 0, 0, 0, 0, 0x0a, 0xc4, 0x42, 0xf0, ...be32(88_200)];
    const comments = vorbisComments([
      'title=Flac',
      'ARTIST=Me',
      'Album=Al',
      'DATE=2020',
      'GENRE=Rock',
      'noequals',
      '=x',
    ]);
    const bytes = [
      ...ascii('fLaC'),
      0x00,
      0,
      0,
      streaminfo.length,
      ...streaminfo,
      0x84,
      (comments.length >> 16) & 0xff,
      ...be16(comments.length & 0xffff),
      ...comments,
    ];
    expect(parse(bytes)).toEqual({
      container: 'flac',
      codecs: ['flac'],
      sampleRate: 44_100,
      channels: 2,
      bitsPerSample: 16,
      durationSeconds: 2,
      title: 'Flac',
      artist: 'Me',
      album: 'Al',
      date: '2020',
      genre: 'Rock',
    });
    expect(parse([...ascii('fLaC'), 0x04, 0, 0, 40, ...le32(3)])).toEqual({
      container: 'flac',
      codecs: ['flac'],
    });
    // A comment length past its block, and a block with no last-block flag that runs out.
    expect(
      parse([...ascii('fLaC'), 0x84, 0, 0, 12, ...le32(0), ...le32(1), ...le32(99)]).title,
    ).toBeUndefined();
    expect(parse([...ascii('fLaC'), 0x01, 0, 0, 0]).codecs).toEqual(['flac']);
  });

  it('reads Ogg Vorbis and Opus headers and the duration from the last page of the stream', () => {
    const vorbisHead = [
      1,
      ...ascii('vorbis'),
      ...le32(0),
      2,
      ...le32(8_000),
      ...new Array<number>(13).fill(0),
    ];
    const vorbisTags = [3, ...ascii('vorbis'), ...vorbisComments(['TITLE=Ogg'])];
    const vorbis = parse([
      ...oggPage(5, 0, [vorbisHead, vorbisTags]),
      ...oggPage(9, 99_999, [[0]]),
      ...oggPage(5, 16_000, [[0]]),
      ...oggPage(9, 99_999, [[0]]),
    ]);
    expect(vorbis).toEqual({
      container: 'ogg',
      codecs: ['vorbis'],
      channels: 2,
      sampleRate: 8_000,
      title: 'Ogg',
      durationSeconds: 2,
    });

    const opusHead = [...ascii('OpusHead'), 1, 1, ...le16(312), ...le32(0), 0, 0, 0];
    const opusTags = [...ascii('OpusTags'), ...vorbisComments(['ARTIST=Opus'])];
    const opus = parse([
      ...oggPage(1, 0, [opusHead]),
      ...oggPage(2, 0, [[0]]),
      ...oggPage(1, 0, [opusTags]),
      ...oggPage(1, 48_312, [[0]]),
    ]);
    expect(opus).toEqual({
      container: 'ogg',
      codecs: ['opus'],
      channels: 1,
      sampleRate: 48_000,
      artist: 'Opus',
      durationSeconds: 1,
    });

    // A packet continued across pages (a 255-byte lacing value) is joined.
    const long = [
      1,
      ...ascii('vorbis'),
      ...le32(0),
      1,
      ...le32(22_050),
      ...new Array<number>(255 - 16).fill(0),
    ];
    const continued = parse([
      ...oggPage(3, 0, [long.slice(0, 255)])
        .slice(0, 27)
        .with(26, 1),
      255,
      ...long,
      ...oggPage(3, 0, [[0]]),
    ]);
    expect(continued).toMatchObject({ codecs: ['vorbis'], sampleRate: 22_050 });
    expect(continued.durationSeconds).toBeUndefined();

    expect(parse(oggPage(1, 0, [ascii('Speex   ')]))).toEqual({ container: 'ogg', codecs: [] });
    expect(parse([...ascii('OggS'), ...new Array<number>(22).fill(0), 3, 1])).toEqual({
      container: 'ogg',
      codecs: [],
    });
  });

  it('reads WAV fmt, data and LIST INFO chunks', () => {
    const info = [
      ...ascii('INFO'),
      ...ascii('INAM'),
      ...le32(5),
      ...ascii('Wave'),
      0,
      0,
      ...ascii('IART'),
      ...le32(2),
      ...ascii('Me'),
      ...ascii('IPRD'),
      ...le32(2),
      ...ascii('Al'),
      ...ascii('ICRD'),
      ...le32(4),
      ...ascii('1990'),
      ...ascii('IGNR'),
      ...le32(3),
      ...ascii('Pop'),
      0,
      ...ascii('ICMT'),
      ...le32(1),
      0x41,
      0,
      ...ascii('ISFT'),
      ...le32(99),
    ];
    const bytes = [
      ...ascii('RIFF'),
      ...le32(0),
      ...ascii('WAVE'),
      ...ascii('fmt '),
      ...le32(16),
      ...le16(3),
      ...le16(1),
      ...le32(1_000),
      ...le32(4_000),
      ...le16(4),
      ...le16(32),
      ...ascii('LIST'),
      ...le32(info.length),
      ...info,
      ...ascii('data'),
      ...le32(2_000),
      ...new Array<number>(2_000).fill(0),
    ];
    expect(parse(bytes)).toEqual({
      container: 'wav',
      codecs: ['pcm-float'],
      channels: 1,
      sampleRate: 1_000,
      bitsPerSample: 32,
      title: 'Wave',
      artist: 'Me',
      album: 'Al',
      date: '1990',
      genre: 'Pop',
      durationSeconds: 0.5,
    });
    const other = parse([
      ...ascii('RIFF'),
      ...le32(0),
      ...ascii('WAVE'),
      ...ascii('fmt '),
      ...le32(16),
      ...le16(85),
      ...new Array<number>(14).fill(0),
      ...ascii('data'),
      ...le32(4),
    ]);
    expect(other.codecs).toEqual(['wav-85']);
    expect(other.durationSeconds).toBeUndefined();
  });

  it('reads MP4 and QuickTime boxes: mvhd, stsd and ilst tags', () => {
    const ftyp = box('ftyp', [...ascii('isom'), ...be32(0), ...ascii('isom')]);
    const item = (type: number[], text: string) =>
      box(type, box('data', [...be32(1), ...be32(0), ...utf8(text)]));
    const ilst = box('ilst', [
      ...item([0xa9, ...ascii('nam')], 'Movie'),
      ...item([0xa9, ...ascii('ART')], 'Maker'),
      ...item([0xa9, ...ascii('alb')], 'Set'),
      ...item([0xa9, ...ascii('day')], '2026'),
      ...item([0xa9, ...ascii('gen')], 'Doc'),
      ...box([0xa9, ...ascii('cmt')], []),
    ]);
    const hdlr = box('hdlr', new Array<number>(25).fill(0));
    const visual = [
      ...ascii('avc1'),
      ...new Array<number>(24).fill(0),
      ...be16(640),
      ...be16(360),
      ...new Array<number>(4).fill(0),
    ];
    const stsd = (entry: number[]) =>
      box('stsd', [0, 0, 0, 0, ...be32(1), ...be32(8 + entry.length), ...entry]);
    const trak = (entry: number[]) => box('trak', box('mdia', box('minf', box('stbl', stsd(entry)))));
    const mvhd1 = box('mvhd', [
      1,
      0,
      0,
      0,
      ...new Array<number>(16).fill(0),
      ...be32(1_000),
      ...be32(0),
      ...be32(1_500),
    ]);
    const bytes = [
      ...ftyp,
      ...box('free', [1, 2, 3]),
      ...box('moov', [
        ...mvhd1,
        ...trak(visual),
        ...trak([...ascii('mp4a'), ...new Array<number>(20).fill(0)]),
        ...trak([0, 1, 2, 3]),
        ...box('udta', box('meta', [0, 0, 0, 0, ...hdlr, ...ilst])),
      ]),
    ];
    expect(parse(bytes)).toEqual({
      container: 'mp4',
      durationSeconds: 1.5,
      codecs: ['avc1', 'mp4a'],
      width: 640,
      height: 360,
      title: 'Movie',
      artist: 'Maker',
      album: 'Set',
      date: '2026',
      genre: 'Doc',
    });

    // Version-0 mvhd, a QuickTime `meta` without version and flags, a 64-bit box size and a box
    // that runs to the end of the file.
    const mvhd0 = box('mvhd', [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(1_200)]);
    const quicktime = [
      ...box('ftyp', ascii('qt  ')),
      ...be32(1),
      ...ascii('wide'),
      ...be32(0),
      ...be32(16),
      ...be32(0),
      ...ascii('moov'),
      ...mvhd0,
      ...box('meta', [...hdlr, ...box('ilst', item([0xa9, ...ascii('nam')], 'QT'))]),
    ];
    expect(parse(quicktime)).toEqual({ container: 'mp4', durationSeconds: 2, codecs: [], title: 'QT' });
    // An item atom at the top level is not a tag; an unknown duration is left out.
    const top = parse([
      ...ftyp,
      ...item([0xa9, ...ascii('nam')], 'Top'),
      ...box('moov', box('mvhd', [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(600), ...be32(0xffffffff)])),
    ]);
    expect(top).toEqual({ container: 'mp4', codecs: [] });
  });

  it('stops MP4 nesting at the block depth limit', () => {
    let nested: number[] = box('mvhd', [0, 0, 0, 0, ...be32(0), ...be32(0), ...be32(1), ...be32(3)]);
    for (let level = 0; level < 5; level++) nested = box('moov', nested);
    const bytes = Uint8Array.from([...box('ftyp', ascii('isom')), ...nested]);
    expect(parse(bytes).durationSeconds).toBe(3);
    const shallow = parseMedia(bytes, new Budget({ ...DEFAULT_LIMITS, blockDepth: 3 }));
    expect(shallow.durationSeconds).toBeUndefined();
  });

  it('leaves other containers to detection', async () => {
    expect(parse(ascii('nothing here'))).toEqual({ codecs: [] });
    const webm = await extract(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
    expect(webm.format).toBe('video');
    expect(webm.metadata).toEqual({});
  });

  it('survives every hostile media file and the fuzz target accepts them', () => {
    const directory = new URL('hostile/media/', root);
    for (const name of readdirSync(directory).sort()) {
      const bytes = read(`hostile/media/${name}`);
      expect(() => parse(bytes)).not.toThrow();
      expect(() => fuzzMedia(bytes)).not.toThrow();
    }
  });

  it('turns a time limit into a library error that the fuzz target accepts', () => {
    const budget = new Budget({ ...DEFAULT_LIMITS, timeMs: 0 });
    const bytes = read('hostile/media/flac-comment-flood.flac');
    expect(() => {
      for (;;) parseMedia(bytes, budget);
    }).toThrow();
  });
});

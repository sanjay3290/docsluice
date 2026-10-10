import type { Budget } from '../../core/budget.js';

/** Container metadata of an audio or video file (#248). Nothing is decoded. */
export interface MediaInfo {
  container?: string;
  title?: string;
  artist?: string;
  album?: string;
  date?: string;
  genre?: string;
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  codecs: string[];
  width?: number;
  height?: number;
}

/** Tags are short; longer values are cut so a tag cannot hold a document's worth of text. */
const MAX_TAG = 1_024;
/** Ogg header packets (identification, comments) assembled past this size are not read. */
const MAX_PACKET = 1_000_000;
/** How far from the end an Ogg reader looks for the last page (its granule gives the duration). */
const OGG_TAIL = 65_536;

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('windows-1252');

function ascii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index++)
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  return true;
}

function u16be(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
}
function u32be(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) << 24) |
      ((bytes[at + 1] ?? 0) << 16) |
      ((bytes[at + 2] ?? 0) << 8) |
      (bytes[at + 3] ?? 0)) >>>
    0
  );
}
function u32le(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}
function u16le(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

/** A tag value: control characters and NUL padding removed, trimmed, and cut to `MAX_TAG`. */
function clean(text: string, budget: Budget): string | undefined {
  let out = '';
  for (let index = 0; index < text.length && out.length < MAX_TAG; index++) {
    budget.tick();
    const code = text.charCodeAt(index);
    out += code < 0x20 && code !== 0x09 ? (code === 0 ? ', ' : ' ') : text[index]!;
  }
  out = out.trim();
  while (out.endsWith(',')) out = out.slice(0, -1).trimEnd();
  return out.length > 0 ? out : undefined;
}

type TagName = 'title' | 'artist' | 'album' | 'date' | 'genre';

function setTag(info: MediaInfo, name: TagName, value: string | undefined, budget: Budget): void {
  if (value === undefined || tag(info, name) !== undefined) return;
  const text = clean(value, budget);
  if (text === undefined) return;
  if (name === 'title') info.title = text;
  else if (name === 'artist') info.artist = text;
  else if (name === 'album') info.album = text;
  else if (name === 'date') info.date = text;
  else info.genre = text;
}

function tag(info: MediaInfo, name: TagName): string | undefined {
  if (name === 'title') return info.title;
  if (name === 'artist') return info.artist;
  if (name === 'album') return info.album;
  return name === 'date' ? info.date : info.genre;
}

/** Vorbis comments (FLAC, Ogg Vorbis, Opus): vendor, then `KEY=value` strings, little-endian lengths. */
function vorbisComments(
  bytes: Uint8Array,
  start: number,
  end: number,
  info: MediaInfo,
  budget: Budget,
): void {
  let at = start;
  const vendor = u32le(bytes, at);
  at += 4 + vendor;
  if (at + 4 > end) return;
  const count = u32le(bytes, at);
  at += 4;
  for (let index = 0; index < count && at + 4 <= end; index++) {
    budget.tick();
    const length = u32le(bytes, at);
    at += 4;
    if (length > end - at) return;
    const entry = utf8.decode(bytes.subarray(at, at + Math.min(length, MAX_TAG * 4)));
    at += length;
    const equals = entry.indexOf('=');
    if (equals <= 0) continue;
    const key = entry.slice(0, equals).toUpperCase();
    const value = entry.slice(equals + 1);
    if (key === 'TITLE') setTag(info, 'title', value, budget);
    else if (key === 'ARTIST') setTag(info, 'artist', value, budget);
    else if (key === 'ALBUM') setTag(info, 'album', value, budget);
    else if (key === 'DATE') setTag(info, 'date', value, budget);
    else if (key === 'GENRE') setTag(info, 'genre', value, budget);
  }
}

/** ID3v2.2–2.4 text frames at the start of an MP3 (id3.org specifications). */
function id3v2(bytes: Uint8Array, info: MediaInfo, budget: Budget): void {
  const major = bytes[3] ?? 0;
  const flags = bytes[5] ?? 0;
  const size =
    (((bytes[6] ?? 0) & 0x7f) << 21) |
    (((bytes[7] ?? 0) & 0x7f) << 14) |
    (((bytes[8] ?? 0) & 0x7f) << 7) |
    ((bytes[9] ?? 0) & 0x7f);
  const end = Math.min(bytes.length, 10 + size);
  // Unsynchronised tags are rare and their frames would need re-synchronising; they are not read.
  if (major < 2 || major > 4 || (flags & 0x80) !== 0) return;
  let at = 10;
  if (major >= 3 && (flags & 0x40) !== 0) at += major === 3 ? 4 + u32be(bytes, at) : synchsafe(bytes, at);
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (at + headerLength <= end) {
    budget.tick();
    if (bytes[at] === 0) break;
    const id = latin1.decode(bytes.subarray(at, at + idLength));
    const frameSize =
      major === 2
        ? ((bytes[at + 3] ?? 0) << 16) | u16be(bytes, at + 4)
        : major === 4
          ? synchsafe(bytes, at + 4)
          : u32be(bytes, at + 4);
    const body = at + headerLength;
    if (frameSize <= 0 || frameSize > end - body) break;
    at = body + frameSize;
    if (id[0] !== 'T') continue;
    const text = id3Text(bytes.subarray(body, body + frameSize));
    if (id === 'TIT2' || id === 'TT2') setTag(info, 'title', text, budget);
    else if (id === 'TPE1' || id === 'TP1') setTag(info, 'artist', text, budget);
    else if (id === 'TALB' || id === 'TAL') setTag(info, 'album', text, budget);
    else if (id === 'TDRC' || id === 'TYER' || id === 'TYE') setTag(info, 'date', text, budget);
    else if (id === 'TCON' || id === 'TCO') setTag(info, 'genre', text, budget);
  }
}

function synchsafe(bytes: Uint8Array, at: number): number {
  return (
    (((bytes[at] ?? 0) & 0x7f) << 21) |
    (((bytes[at + 1] ?? 0) & 0x7f) << 14) |
    (((bytes[at + 2] ?? 0) & 0x7f) << 7) |
    ((bytes[at + 3] ?? 0) & 0x7f)
  );
}

/** An ID3 text frame: an encoding byte, then Latin-1, UTF-16 with BOM, UTF-16BE or UTF-8 text. */
function id3Text(frame: Uint8Array): string {
  const encoding = frame[0];
  const data = frame.subarray(1, 1 + MAX_TAG * 4);
  if (encoding === 1 || encoding === 2) {
    const littleEndian = encoding === 1 && data[0] === 0xff && data[1] === 0xfe;
    const bom =
      encoding === 1 && ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff));
    return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(data.subarray(bom ? 2 : 0));
  }
  return encoding === 3 ? utf8.decode(data) : latin1.decode(data);
}

/** ID3v1: the last 128 bytes, `TAG` then fixed Latin-1 fields. */
function id3v1(bytes: Uint8Array, info: MediaInfo, budget: Budget): void {
  const at = bytes.length - 128;
  if (at < 0 || !ascii(bytes, at, 'TAG')) return;
  setTag(info, 'title', latin1.decode(bytes.subarray(at + 3, at + 33)), budget);
  setTag(info, 'artist', latin1.decode(bytes.subarray(at + 33, at + 63)), budget);
  setTag(info, 'album', latin1.decode(bytes.subarray(at + 63, at + 93)), budget);
  setTag(info, 'date', latin1.decode(bytes.subarray(at + 93, at + 97)), budget);
}

/** FLAC metadata blocks: STREAMINFO (rate, channels, bits, samples) and VORBIS_COMMENT. */
function flac(bytes: Uint8Array, info: MediaInfo, budget: Budget): void {
  info.codecs.push('flac');
  let at = 4;
  for (;;) {
    budget.tick();
    if (at + 4 > bytes.length) return;
    const header = bytes[at]!;
    const length = ((bytes[at + 1] ?? 0) << 16) | u16be(bytes, at + 2);
    const body = at + 4;
    if (length > bytes.length - body) return;
    const type = header & 0x7f;
    if (type === 0 && length >= 18) {
      const rate =
        ((bytes[body + 10] ?? 0) << 12) | ((bytes[body + 11] ?? 0) << 4) | ((bytes[body + 12] ?? 0) >> 4);
      const channels = (((bytes[body + 12] ?? 0) >> 1) & 7) + 1;
      const bits = ((((bytes[body + 12] ?? 0) & 1) << 4) | ((bytes[body + 13] ?? 0) >> 4)) + 1;
      const samples = ((bytes[body + 13] ?? 0) & 0x0f) * 2 ** 32 + u32be(bytes, body + 14);
      if (rate > 0) {
        info.sampleRate = rate;
        if (samples > 0) info.durationSeconds = samples / rate;
      }
      info.channels = channels;
      info.bitsPerSample = bits;
    } else if (type === 4) {
      vorbisComments(bytes, body, body + length, info, budget);
    }
    if ((header & 0x80) !== 0) return;
    at = body + length;
  }
}

/** Ogg pages: the first stream's header packets (Vorbis or Opus), and the last page's granule. */
function ogg(bytes: Uint8Array, info: MediaInfo, budget: Budget): void {
  const packets: Uint8Array[] = [];
  let current: Uint8Array[] = [];
  let currentLength = 0;
  let serial: number | undefined;
  let at = 0;
  while (packets.length < 2 && at + 27 <= bytes.length && ascii(bytes, at, 'OggS')) {
    budget.tick();
    const segments = bytes[at + 26] ?? 0;
    const table = at + 27;
    let body = table + segments;
    if (body > bytes.length) return;
    const pageSerial = u32le(bytes, at + 14);
    serial ??= pageSerial;
    const mine = pageSerial === serial;
    for (let index = 0; index < segments; index++) {
      budget.tick();
      const lacing = bytes[table + index]!;
      if (body + lacing > bytes.length) return;
      if (mine && currentLength + lacing <= MAX_PACKET) {
        current.push(bytes.subarray(body, body + lacing));
        currentLength += lacing;
      }
      body += lacing;
      if (mine && lacing < 255) {
        const packet = new Uint8Array(currentLength);
        let offset = 0;
        for (const part of current) {
          packet.set(part, offset);
          offset += part.length;
        }
        packets.push(packet);
        current = [];
        currentLength = 0;
        if (packets.length === 2) break;
      }
    }
    at = body;
  }
  const [head, tags] = packets;
  if (!head) return;
  let granuleRate = 0;
  let preSkip = 0;
  if (head[0] === 1 && ascii(head, 1, 'vorbis')) {
    info.codecs.push('vorbis');
    info.channels = head[11];
    info.sampleRate = u32le(head, 12);
    granuleRate = info.sampleRate;
    if (tags && tags[0] === 3 && ascii(tags, 1, 'vorbis')) vorbisComments(tags, 7, tags.length, info, budget);
  } else if (ascii(head, 0, 'OpusHead')) {
    info.codecs.push('opus');
    info.channels = head[9];
    preSkip = u16le(head, 10);
    info.sampleRate = u32le(head, 12) || 48_000;
    granuleRate = 48_000;
    if (tags && ascii(tags, 0, 'OpusTags')) vorbisComments(tags, 8, tags.length, info, budget);
  }
  if (granuleRate <= 0 || serial === undefined) return;
  // The last page of the stream: its granule position counts the samples.
  for (let page = bytes.length - 27; page >= Math.max(0, bytes.length - OGG_TAIL); page--) {
    budget.tick();
    if (!ascii(bytes, page, 'OggS') || u32le(bytes, page + 14) !== serial) continue;
    const high = u32le(bytes, page + 10);
    const granule = high * 2 ** 32 + u32le(bytes, page + 6);
    if (high < 0x0020_0000 && granule > preSkip) info.durationSeconds = (granule - preSkip) / granuleRate;
    return;
  }
}

/** RIFF WAVE chunks: `fmt `, `data` (for the duration) and `LIST`/`INFO` tags. */
function wav(bytes: Uint8Array, info: MediaInfo, budget: Budget): void {
  let byteRate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    budget.tick();
    const id = latin1.decode(bytes.subarray(at, at + 4));
    const size = u32le(bytes, at + 4);
    const body = at + 8;
    const available = Math.min(size, bytes.length - body);
    if (id === 'fmt ' && available >= 16) {
      const format = u16le(bytes, body);
      info.codecs.push(format === 1 ? 'pcm' : format === 3 ? 'pcm-float' : `wav-${format}`);
      info.channels = u16le(bytes, body + 2);
      info.sampleRate = u32le(bytes, body + 4);
      byteRate = u32le(bytes, body + 8);
      info.bitsPerSample = u16le(bytes, body + 14);
    } else if (id === 'data') {
      if (byteRate > 0) info.durationSeconds = available / byteRate;
    } else if (id === 'LIST' && ascii(bytes, body, 'INFO')) {
      let item = body + 4;
      const end = body + available;
      while (item + 8 <= end) {
        budget.tick();
        const key = latin1.decode(bytes.subarray(item, item + 4));
        const length = u32le(bytes, item + 4);
        const value = item + 8;
        if (length > end - value) break;
        const text = utf8.decode(bytes.subarray(value, value + Math.min(length, MAX_TAG * 4)));
        if (key === 'INAM') setTag(info, 'title', text, budget);
        else if (key === 'IART') setTag(info, 'artist', text, budget);
        else if (key === 'IPRD') setTag(info, 'album', text, budget);
        else if (key === 'ICRD') setTag(info, 'date', text, budget);
        else if (key === 'IGNR') setTag(info, 'genre', text, budget);
        item = value + length + (length & 1);
      }
    }
    if (size > bytes.length - body) return;
    at = body + size + (size & 1);
  }
}

/** A sample entry type: four printable ASCII characters. */
function isFourCC(text: string): boolean {
  if (text.length !== 4) return false;
  for (let index = 0; index < 4; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return text.trim().length > 0;
}

const MP4_CONTAINERS: ReadonlySet<string> = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst']);
/** iTunes-style item atoms (`©nam` …) under `moov/udta/meta/ilst`. */
const MP4_ITEMS: ReadonlyMap<string, TagName> = new Map([
  ['©nam', 'title'],
  ['©ART', 'artist'],
  ['©alb', 'album'],
  ['©day', 'date'],
  ['©gen', 'genre'],
]);

/** ISO base media (MP4, QuickTime) boxes, walked with an explicit stack (ISO/IEC 14496-12). */
function mp4(bytes: Uint8Array, info: MediaInfo, budget: Budget, maxDepth: number): void {
  const stack: Array<{ start: number; end: number; depth: number }> = [
    { start: 0, end: bytes.length, depth: 0 },
  ];
  while (stack.length > 0) {
    budget.tick();
    const level = stack.pop()!;
    let at = level.start;
    const boxes: Array<{ start: number; end: number; depth: number }> = [];
    while (at + 8 <= level.end) {
      budget.tick();
      let size = u32be(bytes, at);
      const type = latin1.decode(bytes.subarray(at + 4, at + 8));
      let header = 8;
      if (size === 1) {
        if (at + 16 > level.end) break;
        size = u32be(bytes, at + 8) * 2 ** 32 + u32be(bytes, at + 12);
        header = 16;
      } else if (size === 0) {
        size = level.end - at;
      }
      if (size < header || size > level.end - at) break;
      const body = at + header;
      const end = at + size;
      at = end;
      if (type === 'mvhd' && end - body >= 20) {
        const version = bytes[body];
        const scale = version === 1 ? u32be(bytes, body + 20) : u32be(bytes, body + 12);
        const duration =
          version === 1
            ? u32be(bytes, body + 24) * 2 ** 32 + u32be(bytes, body + 28)
            : u32be(bytes, body + 16);
        if (scale > 0 && duration > 0 && duration !== 0xffff_ffff) info.durationSeconds = duration / scale;
      } else if (type === 'stsd' && end - body >= 16) {
        // The first sample entry names the codec; a visual entry also has the frame size.
        const entryType = latin1.decode(bytes.subarray(body + 12, body + 16));
        if (isFourCC(entryType) && info.codecs.length < 16) info.codecs.push(entryType.trim());
        const entry = body + 16;
        if (
          ['avc1', 'avc3', 'hvc1', 'hev1', 'mp4v', 'vp09', 'av01'].includes(entryType) &&
          entry + 28 <= end
        ) {
          info.width ??= u16be(bytes, entry + 24);
          info.height ??= u16be(bytes, entry + 26);
        }
      } else if (type === 'meta') {
        // MP4 `meta` is a full box (version and flags first); QuickTime's has no such field.
        const children = ascii(bytes, body + 4, 'hdlr') ? body : body + 4;
        boxes.push({ start: children, end, depth: level.depth + 1 });
      } else if (MP4_ITEMS.has(type) && level.depth > 0) {
        const name = MP4_ITEMS.get(type)!;
        // The item holds a `data` box: type indicator, locale, then the value.
        if (ascii(bytes, body + 4, 'data')) {
          const dataEnd = Math.min(end, body + u32be(bytes, body));
          setTag(
            info,
            name,
            utf8.decode(bytes.subarray(body + 16, Math.min(dataEnd, body + 16 + MAX_TAG * 4))),
            budget,
          );
        }
      } else if (MP4_CONTAINERS.has(type)) {
        boxes.push({ start: body, end, depth: level.depth + 1 });
      }
    }
    for (let index = boxes.length - 1; index >= 0; index--) {
      budget.tick();
      if (boxes[index]!.depth <= maxDepth) stack.push(boxes[index]!);
    }
  }
}

/**
 * Read the container metadata of an audio or video file: tags (title, artist, album, date, genre)
 * and stream facts (duration, sample rate, channels, codecs, frame size). Formats: MP3 (ID3v2,
 * ID3v1), FLAC, Ogg Vorbis and Opus, WAV, MP4 and QuickTime. Others (Matroska/WebM, raw AAC) give
 * only what detection found.
 */
export function parseMedia(bytes: Uint8Array, budget: Budget): MediaInfo {
  const info: MediaInfo = { codecs: [] };
  if (ascii(bytes, 0, 'ID3')) {
    info.container = 'mp3';
    id3v2(bytes, info, budget);
    id3v1(bytes, info, budget);
  } else if (ascii(bytes, 0, 'fLaC')) {
    info.container = 'flac';
    flac(bytes, info, budget);
  } else if (ascii(bytes, 0, 'OggS')) {
    info.container = 'ogg';
    ogg(bytes, info, budget);
  } else if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) {
    info.container = 'wav';
    wav(bytes, info, budget);
  } else if (ascii(bytes, 4, 'ftyp')) {
    info.container = 'mp4';
    mp4(bytes, info, budget, budget.limits.blockDepth);
  } else if (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    info.container = 'mp3';
    id3v1(bytes, info, budget);
  }
  return info;
}

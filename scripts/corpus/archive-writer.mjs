import { deflateRawSync } from 'node:zlib';

// Deterministic GZIP and TAR writers for corpus and hostile fixtures (RFC 1952, POSIX ustar/pax).

const CRC_TABLE = new Uint32Array(256).map((_, value) => {
  let remainder = value;
  for (let bit = 0; bit < 8; bit++) remainder = remainder & 1 ? 0xedb88320 ^ (remainder >>> 1) : remainder >>> 1;
  return remainder >>> 0;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function concat(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const encoder = new TextEncoder();
const le32 = (value) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];

/** One GZIP member with mtime 0. Options: name, comment, extra (bytes), headerCrc. */
export function gzipMember(data, { name, comment, extra, headerCrc = false } = {}) {
  let flags = 0;
  const fields = [];
  if (extra) {
    flags |= 0x04;
    fields.push(Uint8Array.from([extra.length & 0xff, extra.length >> 8]), extra);
  }
  if (name !== undefined) {
    flags |= 0x08;
    fields.push(encoder.encode(name), Uint8Array.of(0));
  }
  if (comment !== undefined) {
    flags |= 0x10;
    fields.push(encoder.encode(comment), Uint8Array.of(0));
  }
  if (headerCrc) flags |= 0x02;
  let header = concat([Uint8Array.of(0x1f, 0x8b, 8, flags, 0, 0, 0, 0, 0, 0xff), ...fields]);
  if (headerCrc) {
    const crc = crc32(header);
    header = concat([header, Uint8Array.of(crc & 0xff, (crc >>> 8) & 0xff)]);
  }
  const body = deflateRawSync(data, { level: 9 });
  return concat([header, body, Uint8Array.from([...le32(crc32(data)), ...le32(data.length >>> 0)])]);
}

function field(text, length) {
  const bytes = new Uint8Array(length);
  bytes.set(encoder.encode(text).subarray(0, length));
  return bytes;
}

const octal = (value, length) => field(value.toString(8).padStart(length - 1, '0'), length);

/** One ustar header block. `type` is the typeflag character; `size` may lie on purpose. */
export function tarHeader(name, { type = '0', size = 0, linkName = '', prefix = '', mode = 0o644, checksum } = {}) {
  const header = new Uint8Array(512);
  header.set(field(name, 100), 0);
  header.set(octal(mode, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(size, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(field(linkName, 100), 157);
  header.set(field('ustar', 6), 257);
  header.set(field('00', 2), 263);
  header.set(field(prefix, 155), 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(field(`${(checksum ?? sum).toString(8).padStart(6, '0')}\0 `, 8), 148);
  return header;
}

/** A tar entry: header, data, and zero padding to the block size. */
export function tarEntry(name, data = new Uint8Array(), options = {}) {
  const padding = (512 - (data.length % 512)) % 512;
  return concat([tarHeader(name, { size: data.length, ...options }), data, new Uint8Array(padding)]);
}

/** A pax extended header (`x`, or `g` for global) carrying the given records. */
export function paxEntry(records, type = 'x') {
  const lines = records.map(([key, value]) => {
    const body = ` ${key}=${value}\n`;
    let length = body.length + 1;
    while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
    return `${length}${body}`;
  });
  return tarEntry('PaxHeader', encoder.encode(lines.join('')), { type });
}

/** Two zero blocks end the archive. */
export const TAR_END = new Uint8Array(1024);

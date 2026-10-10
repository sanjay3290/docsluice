import { readFileSync } from 'node:fs';
import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { CorruptFileError, EncryptedError } from '../../src/core/errors.js';
import { extract } from '../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import type { Limits } from '../../src/core/limits.js';
import type { ChildDocument } from '../../src/core/model.js';
import { createRegistry } from '../../src/core/registry.js';
import { WarningSink } from '../../src/core/warnings.js';
import { sevenZipPlugin } from '../../src/readers/7z/index.js';
import { list7z } from '../../src/readers/7z/archive.js';
import { decodeLzma } from '../../src/readers/7z/lzma.js';
import { rarPlugin } from '../../src/readers/rar/index.js';
import { listRar } from '../../src/readers/rar/archive.js';
import { cleanEntryName } from '../../src/readers/archive-list/index.js';
import type { ReadContext } from '../../src/core/reader.js';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../corpus/${name}`, import.meta.url)));
const budget = (limits: Partial<Limits> = {}) =>
  new Budget({ ...DEFAULT_LIMITS, ...limits }, { warnings: new WarningSink() });
function registry() {
  const value = createRegistry();
  value.registerFormat(sevenZipPlugin);
  value.registerFormat(rarPlugin);
  return value;
}
const listing = (children: ChildDocument[]) =>
  children.map((child) => [child.path, child.status, child.sizeBytes]);

const EXPECTED_7Z = [
  ['docs', 'skipped', 0],
  ['docs/empty-dir', 'skipped', 0],
  ['docs/empty.txt', 'listed', 0],
  ['data.csv', 'listed', 8],
  ['docs/hello.txt', 'listed', 25],
  ['docs/ünïcode é.txt', 'listed', 16],
];
const EXPECTED_RAR = [
  ['docs', 'skipped', 0],
  ['docs/hello.txt', 'listed', 26],
  ['docs/empty.txt', 'listed', 0],
  ['data.csv', 'listed', 8],
];

describe('7z plugin (ADR 0014)', () => {
  it.each(['listing.7z', 'listing-stored-header.7z'])(
    'lists %s with names, sizes and directories',
    async (name) => {
      const doc = await extract(corpus(`7z/${name}`), { registry: registry() });
      expect(doc.format).toBe('7z');
      expect(doc.mimeType).toBe('application/x-7z-compressed');
      expect(doc.blocks).toEqual([]);
      expect(listing(doc.children)).toEqual(EXPECTED_7Z);
      expect(doc.features.isEncrypted).toBe(false);
    },
  );

  it('decodes an LZMA header with matches and repeated distances', async () => {
    const doc = await extract(corpus('7z/many-files.7z'), { registry: registry() });
    expect(doc.children).toHaveLength(301);
    expect(listing(doc.children.slice(0, 3))).toEqual([
      ['logs', 'skipped', 0],
      ['logs/station-000-reading.log', 'listed', 10],
      ['logs/station-001-reading.log', 'listed', 10],
    ]);
    expect(doc.children.at(-1)!.path).toBe('logs/station-299-reading.log');
  });

  it('lists names of encrypted contents and refuses an encrypted header', async () => {
    const doc = await extract(corpus('7z/encrypted-content.7z'), { registry: registry() });
    expect(doc.features.isEncrypted).toBe(true);
    expect(listing(doc.children)).toEqual(EXPECTED_7Z);
    await expect(extract(corpus('7z/encrypted-header.7z'), { registry: registry() })).rejects.toThrow(
      EncryptedError,
    );
  });

  it('is opt-in: the default registry does not read 7z or RAR', async () => {
    await expect(extract(corpus('7z/listing.7z'))).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
    await expect(extract(corpus('rar/listing-rar5.rar'))).rejects.toMatchObject({
      code: 'UNSUPPORTED_FORMAT',
    });
    expect(sevenZipPlugin.detect!(corpus('rar/listing-rar5.rar'))).toBe(0);
    expect(rarPlugin.detect!(corpus('7z/listing.7z'))).toBe(0);
  });

  it('lists inside another archive with full child paths, and skips with children: skip', async () => {
    const zip = zipSync({ 'nested/archive.7z': corpus('7z/listing.7z') });
    const doc = await extract(zip, { registry: registry() });
    const child = doc.children[0]!.document!;
    expect(child.format).toBe('7z');
    expect(child.children[3]!.path).toBe('nested/archive.7z/data.csv');
    const skipped = await extract(corpus('7z/listing.7z'), { registry: registry(), children: 'skip' });
    expect(skipped.children).toEqual([]);
  });
});

describe('RAR plugin (ADR 0014)', () => {
  it('lists RAR 5 and RAR 4 archives', async () => {
    const rar5 = await extract(corpus('rar/listing-rar5.rar'), { registry: registry() });
    expect(rar5.format).toBe('rar');
    expect(rar5.mimeType).toBe('application/vnd.rar');
    expect(listing(rar5.children)).toEqual([...EXPECTED_RAR, ['docs/café.txt', 'listed', 16]]);
    const rar4 = await extract(corpus('rar/listing-rar4.rar'), { registry: registry() });
    expect(listing(rar4.children)).toEqual(EXPECTED_RAR);
    expect(rar4.warnings).toEqual([]);
  });

  it('reports a damaged header after readable entries', async () => {
    const doc = await extract(
      new Uint8Array(readFileSync(new URL('../../../../hostile/rar/rar5-crc-damage.rar', import.meta.url))),
      { registry: registry() },
    );
    expect(listing(doc.children)).toEqual([['first.txt', 'listed', 5]]);
    expect(doc.warnings.map((warning) => warning.message)).toEqual([
      'The RAR headers are damaged after 1 entries; the entries before the damage are listed.',
    ]);
  });
});

// RAR blocks built by hand for the less common header fields.
const vint = (value: number): number[] => {
  const bytes: number[] = [];
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  } while (value > 0);
  return bytes;
};
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const le32 = (value: number) => [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];
function rar5Block(fields: number[], extra?: number[]): number[] {
  const flags = extra ? 0x1 : 0;
  const body = [
    fields[0]!,
    ...vint(flags),
    ...(extra ? vint(extra.length) : []),
    ...fields.slice(1),
    ...(extra ?? []),
  ];
  const header = Uint8Array.from([...vint(body.length), ...body]);
  return [...le32(crc32(header)), ...header];
}
const RAR5 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00];
function rar4Block(type: number, flags: number, fields: number[], data: number[] = []): number[] {
  const header = Uint8Array.from([
    type,
    flags & 0xff,
    flags >>> 8,
    (7 + fields.length) & 0xff,
    (7 + fields.length) >>> 8,
    ...fields,
  ]);
  const crc = crc32(header) & 0xffff;
  return [crc & 0xff, crc >>> 8, ...header, ...data];
}
const RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
const rar4File = (flags: number, name: number[], { high = false, size = 3 } = {}) =>
  rar4Block(
    0x74,
    0x8000 | flags,
    [
      ...le32(size),
      ...le32(size),
      2,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      29,
      0x30,
      name.length,
      0,
      0x20,
      0,
      0,
      0,
      ...(high ? [...le32(0), ...le32(1)] : []),
      ...name,
    ],
    Array.from({ length: size }, () => 0x61),
  );

describe('RAR headers', () => {
  it('reads RAR 5 encryption records, unknown sizes, service headers and the end header', () => {
    const name = [...new TextEncoder().encode('secret.bin')];
    const bytes = Uint8Array.from([
      ...RAR5,
      ...rar5Block([1, ...vint(0)]),
      ...rar5Block([
        3,
        ...vint(0),
        ...vint(0),
        ...vint(0),
        ...vint(0),
        ...vint(0),
        ...vint(3),
        0x43,
        0x4d,
        0x54,
      ]),
      ...rar5Block(
        [2, ...vint(0x8), ...vint(0), ...vint(0x20), ...vint(0), ...vint(0), ...vint(name.length), ...name],
        [2, 1, 0],
      ),
      ...rar5Block([5, ...vint(0)]),
      0xde,
      0xad,
    ]);
    expect(listRar(bytes, budget())).toEqual({
      entries: [{ name: 'secret.bin', size: 0, directory: false }],
      encrypted: true,
      damaged: false,
    });
  });

  it('reads RAR 4 large sizes, encrypted files, Unicode names and skips other blocks', () => {
    const bytes = Uint8Array.from([
      ...RAR4,
      ...rar4Block(0x73, 0, [0, 0, 0, 0, 0, 0]),
      ...rar4Block(0x75, 0x8000, [...le32(2), 0, 0], [0, 0]),
      ...rar4File(0x100 | 0x04, [0x41], { high: true }),
      ...rar4File(0x200, [0x42, 0x00, 0x99]),
      ...rar4File(0x200, [...new TextEncoder().encode('ü')]),
      ...rar4File(0, [0xe9]),
      ...rar4Block(0x7b, 0x4000, []),
    ]);
    expect(listRar(bytes, budget())).toEqual({
      entries: [
        { name: 'A', size: 2 ** 32 + 3, directory: false },
        { name: 'B', size: 3, directory: false },
        { name: 'ü', size: 3, directory: false },
        { name: 'é', size: 3, directory: false },
      ],
      encrypted: true,
      damaged: false,
    });
  });

  it.each([
    ['no signature', [0x52, 0x61, 0x72]],
    ['a RAR 5 header past the end', [...RAR5, 0, 0, 0, 0, 0x7f]],
    ['a RAR 5 header of size zero', [...RAR5, 0, 0, 0, 0, 0]],
    [
      'a RAR 5 header with a bad CRC',
      [...RAR5, ...rar5Block([1, ...vint(0)]).map((byte, index) => (index === 0 ? byte ^ 1 : byte))],
    ],
    ['a RAR 4 header shorter than 7 bytes', [...RAR4, 0, 0, 0x74, 0, 0x80, 3, 0, 0, 0, 0, 0]],
    ['a RAR 4 file header too short', [...RAR4, ...rar4Block(0x74, 0x8000, [0, 0, 0, 0])]],
    [
      'a RAR 4 large file header too short',
      [
        ...RAR4,
        ...rar4Block(
          0x74,
          0x8100,
          Array.from({ length: 26 }, () => 0),
        ),
      ],
    ],
    ['a RAR 4 long block without its size', [...RAR4, ...rar4Block(0x75, 0x8000, [0])]],
    [
      'a RAR 4 name past the header',
      [...RAR4, ...rar4Block(0x74, 0x8000, [...Array.from({ length: 19 }, () => 0), 0x40, 0, 0, 0, 0, 0])],
    ],
  ])('rejects %s', (_case, bytes) => {
    expect(() => listRar(Uint8Array.from(bytes), budget())).toThrow(CorruptFileError);
  });

  it('rejects RAR 5 extra records that do not fit', () => {
    const name = [0x61];
    const bad = Uint8Array.from([
      ...RAR5,
      ...rar5Block(
        [2, ...vint(0), ...vint(0), ...vint(0), ...vint(0), ...vint(0), ...vint(1), ...name],
        [9, 1],
      ),
    ]);
    expect(() => listRar(bad, budget())).toThrow(CorruptFileError);
    const longName = Uint8Array.from([
      ...RAR5,
      ...rar5Block([2, ...vint(0), ...vint(0), ...vint(0), ...vint(0), ...vint(0), ...vint(9)]),
    ]);
    expect(() => listRar(longName, budget())).toThrow(CorruptFileError);
  });
});

// 7z headers built by hand (stored, so no LZMA needed) for the less common properties.
function number(value: number): number[] {
  if (value < 0x80) return [value];
  if (value < 0x4000) return [0x80 | (value >>> 8), value & 0xff];
  return [0xc0 | (value >>> 16), value & 0xff, (value >>> 8) & 0xff];
}
function sevenZip(header: number[], packed: number[] = []): Uint8Array {
  const size = header.length;
  const offset = packed.length;
  return Uint8Array.from([
    0x37,
    0x7a,
    0xbc,
    0xaf,
    0x27,
    0x1c,
    0,
    4,
    0,
    0,
    0,
    0,
    ...le32(offset),
    0,
    0,
    0,
    0,
    ...le32(size),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    ...packed,
    ...header,
  ]);
}
const utf16z = (text: string) => [...text].flatMap((char) => [char.charCodeAt(0), 0]).concat([0, 0]);
const names = (...values: string[]) => {
  const data = [0, ...values.flatMap(utf16z)];
  return [0x11, ...number(data.length), ...data];
};
/** Two LZMA-free folders (Copy coder) with three streams, CRCs and attributes. */
const richHeader = [
  0x01,
  0x02,
  0x19,
  0x01,
  0x00,
  0x00, // archive properties: one dummy property, then end
  0x04, // main streams
  0x06,
  0x00,
  0x02,
  0x09,
  0x05,
  0x02,
  0x0a,
  0x00,
  0x80,
  0x01,
  0x02,
  0x03,
  0x04,
  0x00, // pack info, one CRC
  0x07,
  0x0b,
  0x02,
  0x00,
  0x01,
  0x01,
  0x00, // folder 1: Copy
  0x01,
  0x31,
  0x00,
  0x01,
  0x01,
  0x00, // folder 2: complex Copy coder, 1 in / 1 out, no properties
  0x0c,
  0x05,
  0x02,
  0x0a,
  0x01,
  0x01,
  0x02,
  0x03,
  0x04,
  0x05,
  0x06,
  0x07,
  0x08, // both folder CRCs
  0x00,
  0x08,
  0x0d,
  0x02,
  0x01,
  0x09,
  0x03,
  0x0a,
  0x00,
  0x40,
  0x01,
  0x02,
  0x03,
  0x04,
  0x00, // 2+1 streams
  0x00,
  0x05,
  0x05, // files
  0x0e,
  0x01,
  0b0001_1000, // entries 4 and 5 are empty streams
  0x0f,
  0x01,
  0b1000_0000, // entry 4 is an empty file, entry 5 a directory
  ...names('a.txt', 'b.txt', 'c.txt', 'empty', 'dir'),
  0x15,
  0x07,
  0x00,
  0b0000_1000,
  0x00,
  0x10,
  0,
  0,
  0, // attributes: only entry 5, a directory
  0x19,
  0x00, // dummy
  0x00,
  0x00,
];

describe('7z headers', () => {
  it('reads archive properties, several folders, substreams, digests and attributes', () => {
    const result = list7z(sevenZip(richHeader, [0, 0, 0, 0, 0, 0, 0]), budget());
    expect(result).toEqual({
      encrypted: false,
      entries: [
        { name: 'a.txt', size: 3, directory: false },
        { name: 'b.txt', size: 2, directory: false },
        { name: 'c.txt', size: 2, directory: false },
        { name: 'empty', size: 0, directory: false },
        { name: 'dir', size: 0, directory: true },
      ],
    });
  });

  it('reads a stored encoded header and an empty archive', () => {
    const header = [0x01, 0x05, 0x01, 0x0e, 0x01, 0x80, 0x0f, 0x01, 0x80, ...names('only'), 0x00, 0x00];
    const encoded = [
      0x17,
      0x06,
      0x00,
      0x01,
      0x09,
      header.length,
      0x00,
      0x07,
      0x0b,
      0x01,
      0x00,
      0x01,
      0x01,
      0x00,
      0x0c,
      header.length,
      0x00,
      0x00,
    ];
    expect(list7z(sevenZip(encoded, header), budget()).entries).toEqual([
      { name: 'only', size: 0, directory: false },
    ]);
    expect(list7z(sevenZip([]), budget())).toEqual({ entries: [], encrypted: false });
    expect(list7z(sevenZip([0x01, 0x00]), budget())).toEqual({ entries: [], encrypted: false });
  });

  it('returns no entries when the uncompressed allowance is spent', () => {
    const header = [0x01, 0x05, 0x01, 0x0e, 0x01, 0x80, 0x0f, 0x01, 0x80, ...names('only'), 0x00, 0x00];
    const encoded = [
      0x17,
      0x06,
      0x00,
      0x01,
      0x09,
      header.length,
      0x00,
      0x07,
      0x0b,
      0x01,
      0x00,
      0x01,
      0x01,
      0x00,
      0x0c,
      header.length,
      0x00,
      0x00,
    ];
    const tight = budget({ totalUncompressedBytes: 4 });
    expect(list7z(sevenZip(encoded, header), tight)).toEqual({ entries: [], encrypted: false });
    expect(tight.truncated).toBe(true);
  });

  it.each([
    ['a missing signature', Uint8Array.from([0x37, 0x7a, 0, 0])],
    ['a short signature header', Uint8Array.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 4])],
    ['a next header past the end', sevenZip([0x01, 0x00]).subarray(0, 33)],
    ['an unknown top-level property', sevenZip([0x02])],
    ['a file stream without a size', sevenZip([0x01, 0x05, 0x01, ...names('x'), 0x00, 0x00])],
    [
      'a stored header that does not match its size',
      sevenZip(
        [
          0x17, 0x06, 0x00, 0x01, 0x09, 0x02, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x05,
          0x00, 0x00,
        ],
        [0, 0],
      ),
    ],
    [
      'an unknown header coder',
      sevenZip(
        [
          0x17, 0x06, 0x00, 0x01, 0x09, 0x02, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x21, 0x0c, 0x02,
          0x00, 0x00,
        ],
        [0, 0],
      ),
    ],
    [
      'two header folders',
      sevenZip(
        [
          0x17, 0x06, 0x00, 0x01, 0x09, 0x02, 0x00, 0x07, 0x0b, 0x02, 0x00, 0x01, 0x01, 0x00, 0x01, 0x01,
          0x00, 0x0c, 0x01, 0x01, 0x00, 0x00,
        ],
        [0, 0],
      ),
    ],
    [
      'a packed stream past the end',
      sevenZip([
        0x17, 0x06, 0x00, 0x01, 0x09, 0x40, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x02, 0x00,
        0x00,
      ]),
    ],
    [
      'an alternative coder flag',
      sevenZip(
        [
          0x17, 0x06, 0x00, 0x01, 0x09, 0x02, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x81, 0x00, 0x0c, 0x02,
          0x00, 0x00,
        ],
        [0, 0],
      ),
    ],
    ['no coders', sevenZip([0x17, 0x07, 0x0b, 0x01, 0x00, 0x00, 0x0c, 0x02, 0x00, 0x00])],
    ['an external folder list', sevenZip([0x17, 0x07, 0x0b, 0x01, 0x01, 0x00])],
    ['unknown pack info', sevenZip([0x17, 0x06, 0x00, 0x01, 0x0b])],
    ['unknown unpack info', sevenZip([0x17, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x02, 0x0b])],
    ['unknown substream info', sevenZip([0x01, 0x04, 0x08, 0x0b])],
    [
      'substream sizes larger than the folder',
      sevenZip([
        0x01, 0x04, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x02, 0x00, 0x08, 0x0d, 0x02, 0x09, 0x05,
        0x00, 0x00,
      ]),
    ],
    [
      'a stream info without an end',
      sevenZip([0x01, 0x04, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x01, 0x00, 0x0c, 0x02, 0x00, 0x0b]),
    ],
    [
      'bound streams without packed streams',
      sevenZip([0x01, 0x04, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x11, 0x00, 0x01, 0x03, 0x0c]),
    ],
    ['a non-zero name external flag', sevenZip([0x01, 0x05, 0x01, 0x11, 0x01, 0x01, 0x00, 0x00])],
    ['a non-zero attribute external flag', sevenZip([0x01, 0x05, 0x01, 0x15, 0x02, 0x01, 0x01, 0x00, 0x00])],
    [
      'too many coders',
      sevenZip([0x17, 0x07, 0x0b, 0x01, 0x00, 0x41, ...Array.from({ length: 140 }, () => 0)]),
    ],
    [
      'a complex coder with too many streams',
      sevenZip([0x17, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x11, 0x00, 0x41, 0x01]),
    ],
  ])('rejects %s', (_case, bytes) => {
    expect(() => list7z(bytes, budget())).toThrow(CorruptFileError);
  });

  it('refuses an AES-encrypted header', () => {
    const aes = [
      0x17, 0x06, 0x00, 0x01, 0x09, 0x02, 0x00, 0x07, 0x0b, 0x01, 0x00, 0x01, 0x04, 0x06, 0xf1, 0x07, 0x01,
      0x0c, 0x02, 0x00, 0x00,
    ];
    expect(() => list7z(sevenZip(aes, [0, 0]), budget())).toThrow(EncryptedError);
  });
});

describe('LZMA decoder', () => {
  it.each([
    ['short properties', Uint8Array.of(0, 0, 0, 0, 0), Uint8Array.of(0x5d)],
    ['invalid properties', Uint8Array.of(0, 0, 0, 0, 0), Uint8Array.of(225, 0, 0, 1, 0)],
    ['a short stream', Uint8Array.of(0, 0), Uint8Array.of(0x5d, 0, 0, 1, 0)],
    ['a non-zero first byte', Uint8Array.of(1, 0, 0, 0, 0), Uint8Array.of(0x5d, 0, 0, 1, 0)],
    ['a code above the range', Uint8Array.of(0, 0xff, 0xff, 0xff, 0xff), Uint8Array.of(0x5d, 0, 0, 1, 0)],
    ['input that runs out', Uint8Array.of(0, 0, 0, 0, 0), Uint8Array.of(0x5d, 0, 0, 1, 0)],
  ])('rejects %s', (_case, input, properties) => {
    expect(() => decodeLzma(input, properties, 64, budget())).toThrow(CorruptFileError);
  });
});

describe('listed entry names', () => {
  const ctx = { budget: budget() } as unknown as ReadContext;
  it.each([
    ['..\\..\\windows\\system32', 'windows/system32'],
    ['C:\\temp\\a.txt', 'temp/a.txt'],
    ['/./etc//passwd', 'etc/passwd'],
    ['a\u0001b\u007fc', 'a\ufffdb\ufffdc'],
    ['..', 'entry'],
    ['1:', '1:'],
  ])('%j becomes %j', (input, output) => {
    expect(cleanEntryName(input, ctx)).toBe(output);
  });
});

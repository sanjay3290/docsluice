import { describe, expect, it } from 'vitest';
import { decodeText, detectEncoding } from '../../src/detect/encoding.js';
import { detectTextKind, detectTextKindCandidates } from '../../src/detect/text-kind.js';
import { fuzzDetection } from '../../fuzz/detection.fuzz.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12);
  new DataView(result.buffer).setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) result[i + 4] = type.charCodeAt(i);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < result.length - 4; i += 1) {
    crc ^= result[i] ?? 0;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  new DataView(result.buffer).setUint32(result.length - 4, (crc ^ 0xffffffff) >>> 0);
  return result;
}

function validRgb64Png(): Uint8Array {
  const signature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = chunk('IHDR', Uint8Array.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 2, 0, 0, 0]));
  const compressed = Uint8Array.from(
    atob(
      'eJzVzkERAAAMgzCkV/pE8OAWBWHPUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQBizpgUQcs6oBFHbCoAxZ1wKIOWNQB6wAfPgFp',
    ),
    (character) => character.charCodeAt(0),
  );
  const imageData = chunk('IDAT', compressed);
  const textData = new Uint8Array(4159 - compressed.length);
  textData.set(utf8('note\0'));
  textData.fill(0x41, 5);
  const text = chunk('tEXt', textData);
  const end = chunk('IEND', new Uint8Array());
  const png = new Uint8Array(signature.length + header.length + imageData.length + text.length + end.length);
  let offset = 0;
  for (const part of [signature, header, imageData, text, end]) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function validStoredZip(): Uint8Array {
  const name = utf8('a.txt');
  const data = utf8('A'.repeat(4120));
  const checksumInput = data;
  let crc = 0xffffffff;
  for (const byte of checksumInput) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;

  const local = new Uint8Array(30 + name.length + data.length);
  const localView = new DataView(local.buffer);
  localView.setUint32(0, 0x04034b50, true);
  localView.setUint16(4, 20, true);
  localView.setUint32(14, crc, true);
  localView.setUint32(18, data.length, true);
  localView.setUint32(22, data.length, true);
  localView.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);

  const central = new Uint8Array(46 + name.length);
  const centralView = new DataView(central.buffer);
  centralView.setUint32(0, 0x02014b50, true);
  centralView.setUint16(4, 20, true);
  centralView.setUint16(6, 20, true);
  centralView.setUint32(16, crc, true);
  centralView.setUint32(20, data.length, true);
  centralView.setUint32(24, data.length, true);
  centralView.setUint16(28, name.length, true);
  centralView.setUint32(42, 0, true);
  central.set(name, 46);

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 1, true);
  endView.setUint16(10, 1, true);
  endView.setUint32(12, central.length, true);
  endView.setUint32(16, local.length, true);

  const zip = new Uint8Array(local.length + central.length + end.length);
  zip.set(local);
  zip.set(central, local.length);
  zip.set(end, local.length + central.length);
  return zip;
}

function controlByteRatio(bytes: Uint8Array): number {
  let controls = 0;
  for (const byte of bytes) {
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0c && byte !== 0x0d) controls += 1;
  }
  return controls / bytes.length;
}

describe('encoding detection', () => {
  it('detects UTF-8 with and without a BOM', () => {
    expect(detectEncoding(utf8('hello €'))).toMatchObject({ isText: true, encoding: 'utf-8' });
    expect(detectEncoding(Uint8Array.from([0xef, 0xbb, 0xbf, ...utf8('hello')]))).toMatchObject({
      isText: true,
      encoding: 'utf-8',
    });
  });

  it('detects UTF-16 with a BOM and from NUL-byte patterns', () => {
    expect(detectEncoding(Uint8Array.from([0xff, 0xfe, 0x41, 0, 0xac, 0x20]))).toMatchObject({
      isText: true,
      encoding: 'utf-16le',
    });
    expect(detectEncoding(Uint8Array.from([0xfe, 0xff, 0, 0x41, 0x20, 0xac]))).toMatchObject({
      isText: true,
      encoding: 'utf-16be',
    });
    expect(detectEncoding(Uint8Array.from([0x41, 0, 0x42, 0, 0x43, 0]))).toMatchObject({
      isText: true,
      encoding: 'utf-16le',
    });
    expect(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0, 0xac, 0x20]), 'utf-16le')).toBe('A€');
    expect(decodeText(Uint8Array.from([0xfe, 0xff, 0, 0x41, 0x20, 0xac]), 'utf-16be')).toBe('A€');
  });

  it('reports UTF-32 as unsupported', () => {
    expect(detectEncoding(Uint8Array.from([0xff, 0xfe, 0, 0, 0x41, 0, 0, 0]))).toMatchObject({
      isText: false,
      encoding: 'unsupported',
    });
  });

  it('uses Windows-1252 for invalid UTF-8 and warns', () => {
    const result = detectEncoding(Uint8Array.from([0x80, 0x93, 0x68, 0x69, 0x94]));
    expect(result).toMatchObject({ isText: true, encoding: 'windows-1252', warning: 'ENCODING_GUESSED' });
    expect(decodeText(Uint8Array.from([0x80, 0x93, 0x68, 0x69, 0x94]), result.encoding)).toBe('€“hi”');
  });

  it('keeps a multibyte UTF-8 character crossing the sample edge valid', () => {
    const bytes = Uint8Array.from([...utf8('a'.repeat(8191)), 0xe2, 0x82, 0xac]);
    expect(detectEncoding(bytes)).toMatchObject({ isText: true, encoding: 'utf-8' });
  });

  it('does not inspect bytes after a complete sample boundary', () => {
    const bytes = Uint8Array.from([...utf8('a'.repeat(8192)), 0x80]);
    expect(detectEncoding(bytes)).toMatchObject({ isText: true, encoding: 'utf-8' });
  });

  it.each([
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0x1a, 0, 0xff, 0, 0, 0]),
    Uint8Array.from([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0]),
  ])('rejects binary control-byte data as text', (bytes) => {
    expect(detectEncoding(bytes).isText).toBe(false);
  });

  it('rejects a valid low-control 64x64 RGB PNG by its signature', () => {
    const png = validRgb64Png();
    expect(png).toHaveLength(4228);
    expect(controlByteRatio(png)).toBeLessThan(0.3);
    expect(detectEncoding(png).isText).toBe(false);
  });

  it('rejects a valid low-control ZIP even when the sample is mostly printable bytes', () => {
    const zip = validStoredZip();
    expect(zip).toHaveLength(4228);
    expect(controlByteRatio(zip)).toBeLessThan(0.3);
    expect(detectEncoding(zip).isText).toBe(false);
  });

  it('recognizes BOM-less UTF-16 text whose non-ASCII letters have no printable ASCII bytes', () => {
    expect(detectEncoding(Uint8Array.from([0xe9, 0, 0xe9, 0, 0xe9, 0]))).toMatchObject({
      isText: true,
      encoding: 'utf-16le',
    });
    expect(detectEncoding(Uint8Array.from([0, 0xe9, 0, 0xe9, 0, 0xe9]))).toMatchObject({
      isText: true,
      encoding: 'utf-16be',
    });
  });

  it('classifies a 10 MB single-line text input within the scan budget', () => {
    const text = 'x'.repeat(10 * 1024 * 1024);
    const bytes = utf8(text);
    const start = performance.now();
    expect(detectEncoding(bytes).isText).toBe(true);
    expect(detectTextKind(text)).toBe('txt');
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('text kind detection', () => {
  it('reports CSV and TSV as tied while preserving CSV as the default choice', () => {
    const text = 'a,b\tc,d\n1,2\t3,4';

    expect(detectTextKindCandidates(text)).toEqual(['csv', 'tsv']);
    expect(detectTextKind(text)).toBe('csv');
  });

  it('survives arbitrary malformed bytes through the fuzz entry point', () => {
    for (let seed = 0; seed < 256; seed += 1) {
      const bytes = new Uint8Array(seed);
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (seed * 31 + i * 17) & 0xff;
      expect(() => fuzzDetection(bytes)).not.toThrow();
    }
  });

  it.each([
    ['{"a":1}', 'json'],
    ['[1, true, null]', 'json'],
    [' {"nested":{"ok":false}} ', 'json'],
    ['<?xml version="1.0"?><root/>', 'xml'],
    ['<root><child>text</child></root>', 'xml'],
    ['<root><body>not HTML</body></root>', 'xml'],
    ['<feed xmlns="urn:test"><entry/></feed>', 'xml'],
    ['<!doctype html><html><body>Hello</body></html>', 'html'],
    ['<html lang="en"><title>x</title></html>', 'html'],
    ['<body><p>Hello</p></body>', 'html'],
    ['name,value\na,1\nb,2', 'csv'],
    ['name;value\na;1\nb;2', 'csv'],
    ['name,description\n"first, row","line one\nline two"\nnext,ok', 'csv'],
    ['name\tvalue\na\t1\nb\t2', 'tsv'],
    ['a\tb\n1\t2\n3\t4', 'tsv'],
    ['one\ttwo\nthree\tfour', 'tsv'],
    ['# Heading\n\nSome text', 'markdown'],
    ['- one\n- two\n', 'markdown'],
    ['```js\nconst x = 1;\n```', 'markdown'],
    ['[label](https://example.test)', 'markdown'],
    ['This is ordinary prose.', 'txt'],
    ['<not a tag>', 'txt'],
    ['{"unfinished":', 'txt'],
    ['{"a":1,}', 'txt'],
    ['{"x":TRUE}', 'txt'],
    ['{"x":False}', 'txt'],
    ['{"x":Null}', 'txt'],
    ['{"s":"escaped \\" quote","n":-1.25e+2}', 'json'],
    ['<?XML version="1.0"?><root/>', 'xml'],
    ['<root a="valid attribute"/>', 'xml'],
    ['<not a tag>', 'txt'],
    ['a,b\r\n"quoted ""comma, value""",2\r\nnext,3', 'csv'],
    ['a,b\nc,d\nordinary text\n', 'txt'],
    ['# Heading\nplain text\n', 'markdown'],
    ['plain [link](url)', 'markdown'],
  ] as const)('detects %s as %s', (text, expected) => {
    expect(detectTextKind(text)).toBe(expected);
  });
});

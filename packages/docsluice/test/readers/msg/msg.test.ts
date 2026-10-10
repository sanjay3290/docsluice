import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { LimitExceededError } from '../../../src/core/errors.js';
import { extract } from '../../../src/core/extract.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { Block, DocsluiceDocument } from '../../../src/core/model.js';
import { toJSON } from '../../../src/render/json.js';
import { openCfb } from '../../../src/ole/index.js';
import { writeCfb } from '../../../src/ole/write.js';
import { decompressRtf } from '../../../src/readers/msg/lzfu.js';
import { fuzzMsg } from '../../../fuzz/msg.fuzz.js';
import { attachment, buildMsg, compressedRtf, utf16z } from '../../helpers/msg.js';

const corpus = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../../corpus/${name}`, import.meta.url)));
const hex = (text: string) => Uint8Array.from(text.trim().split(/\s+/), (value) => parseInt(value, 16));
const utf8 = (text: string) => new TextEncoder().encode(text);

function headerRows(doc: DocsluiceDocument): string[][] {
  const table = doc.blocks.find((block) => block.kind === 'table');
  return table?.kind === 'table' ? table.rows.map((row) => row.map((cell) => cell.text)) : [];
}

function paragraphs(blocks: Block[]): string[] {
  return blocks.flatMap((block) => (block.kind === 'paragraph' ? [block.text] : []));
}

describe('MSG reader', () => {
  it('reads an Outlook-produced message: header table, metadata and plain body', async () => {
    const doc = await extract(corpus('ole/test_outlook_msg.msg'));
    expect(doc.format).toBe('msg');
    expect(doc.metadata).toMatchObject({ title: 'Test Email Message', created: '2024-12-22T08:23:00.000Z' });
    expect(headerRows(doc).map((row) => row[0])).toEqual(['Field', 'From', 'To', 'Date', 'Subject']);
    expect(paragraphs(doc.blocks)).toEqual(['This is the body of the test email message']);
    expect(doc.warnings).toEqual([]);
  });

  it('lists To and Cc recipients with addresses and extracts attachments as children', async () => {
    const doc = await extract(corpus('msg/plain-attachments.msg'));
    expect(headerRows(doc)).toEqual([
      ['Field', 'Value'],
      ['From', 'Ada Field <ada@example.org>'],
      ['To', 'Grace Plot <grace@example.org>, Alan Count <alan@example.org>'],
      ['Cc', 'Survey Desk <desk@example.org>'],
      ['Date', '2025-03-14T09:30:00.000Z'],
      ['Subject', 'Field survey schedule'],
    ]);
    expect(paragraphs(doc.blocks)).toHaveLength(3);
    expect(doc.children.map((child) => [child.name, child.mimeType, child.document?.format])).toEqual([
      ['plots.txt', 'text/plain', 'txt'],
      ['counts.csv', 'text/csv', 'csv'],
    ]);
    expect(doc.features.hasEmbeddedFiles).toBe(true);
  });

  it('hides sender and recipients without metadata', async () => {
    const doc = await extract(corpus('msg/plain-attachments.msg'), { metadata: false });
    expect(headerRows(doc).map((row) => row[0])).toEqual(['Field', 'Date', 'Subject']);
    expect(doc.metadata.authors).toBeUndefined();
  });

  it('turns an embedded message into a nested .msg child with its own attachments', async () => {
    const doc = await extract(corpus('msg/embedded-message.msg'));
    const child = doc.children[0]!;
    expect(child.name).toBe('Field survey schedule.msg');
    expect(child.mimeType).toBe('application/vnd.ms-outlook');
    expect(child.document?.format).toBe('msg');
    expect(child.document?.metadata.title).toBe('Field survey schedule');
    expect(paragraphs(child.document!.blocks)).toEqual(['The river survey starts on Monday at 08:00.']);
    const grandchild = child.document!.children[0]!;
    expect(grandchild.path).toBe('Field survey schedule.msg/plots.txt');
    expect(grandchild.document?.format).toBe('txt');
  });

  it('treats an object storage with a property stream as an embedded message when the method is missing', async () => {
    const doc = await extract(
      buildMsg({ attachments: [{ strings: [[0x3001, 'fwd']], embedded: { strings: [[0x0037, 'inner']] } }] }),
    );
    expect(doc.children.map((child) => [child.name, child.document?.metadata.title])).toEqual([
      ['fwd.msg', 'inner'],
    ]);
  });

  it('stops nesting embedded messages at childDepth', async () => {
    let message = { strings: [[0x0037, 'innermost']] } as Parameters<typeof buildMsg>[0];
    for (let level = 0; level < 6; level++) {
      message = {
        strings: [[0x0037, `level ${level}`]],
        attachments: [{ strings: [[0x3001, `level ${level}`]], longs: [[0x3705, 5]], embedded: message }],
      };
    }
    const doc = await extract(buildMsg(message), { limits: { childDepth: 3 } });
    expect(doc.warnings.map((warning) => warning.code)).toContain('DEPTH_LIMIT');
    let depth = 0;
    for (let current: DocsluiceDocument | undefined = doc; current; current = current.children[0]?.document)
      depth++;
    expect(depth).toBe(4);
  });

  it('prefers PR_BODY, then PR_HTML with cid references, then compressed RTF', async () => {
    const html = await extract(corpus('msg/html-body.msg'));
    expect(html.blocks.some((block) => block.kind === 'heading' && block.text === 'Weekly counts')).toBe(
      true,
    );
    expect(html.blocks.some((block) => block.kind === 'table' && block.rows.length === 3)).toBe(true);
    expect(JSON.stringify(html.blocks)).toContain('"ref":"wren.txt"');

    const fromHtml = await extract(corpus('msg/rtf-fromhtml.msg'));
    expect(paragraphs(fromHtml.blocks)).toEqual([
      'The tide table for April is ready.',
      'High water at 06:12 and 18:40.',
    ]);

    const both = await extract(
      buildMsg({
        strings: [[0x1000, 'Plain wins.']],
        binaries: [
          [0x1013, utf8('<p>HTML loses.</p>')],
          [0x1009, compressedRtf('{\\rtf1 RTF loses.}')],
        ],
      }),
    );
    expect(paragraphs(both.blocks)).toEqual(['Plain wins.']);
  });

  it('decodes 8-bit strings in the message code page and warns once for an unknown one', async () => {
    const cyrillic = await extract(corpus('msg/rtf-ansi-1251.msg'));
    expect(cyrillic.metadata.title).toBe('Отчет о съемке');
    expect(paragraphs(cyrillic.blocks)[0]).toBe('Plain RTF body, repeated: survey survey survey.');

    const unknown = await extract(
      buildMsg({
        ansi: true,
        strings: [
          [0x0037, 'Café'],
          [0x1000, 'Body'],
        ],
        longs: [[0x3ffd, 99_999]],
      }),
    );
    expect(unknown.metadata.title).toBe('Café');
    expect(unknown.warnings.filter((warning) => warning.code === 'ENCODING_GUESSED')).toHaveLength(1);
  });

  it('lists attachments without reading them in list mode and skips them in skip mode', async () => {
    const listed = await extract(corpus('msg/embedded-message.msg'), { children: 'list' });
    expect(listed.children.map((child) => [child.name, child.status])).toEqual([
      ['Field survey schedule.msg', 'listed'],
    ]);
    const skipped = await extract(corpus('msg/embedded-message.msg'), { children: 'skip' });
    expect(skipped.children).toEqual([]);
    expect(skipped.features.hasEmbeddedFiles).toBe(true);
  });

  it('warns about attachments without data and sanitizes attachment names', async () => {
    const doc = await extract(
      buildMsg({
        strings: [[0x1000, 'See attached.']],
        attachments: [
          { strings: [[0x3707, 'by-reference.txt']], longs: [[0x3705, 2]] },
          attachment('..\\..\\evil/name.txt', utf8('ok\n')),
        ],
      }),
    );
    expect(doc.children.map((child) => child.name)).toEqual(['_.._evil_name.txt']);
    expect(doc.warnings).toEqual([
      {
        code: 'UNREADABLE_PART',
        message: '1 attachment(s) had no readable data (stored by reference or damaged).',
      },
    ]);
  });

  it('falls back to display recipients and sent-representing sender', async () => {
    const doc = await extract(
      buildMsg({
        strings: [
          [0x0042, 'Delegate'],
          [0x0065, 'delegate@example.org'],
          [0x0e04, 'Someone; Other'],
          [0x0e03, 'Copy'],
        ],
        times: [[0x0e06, '2025-01-02T03:04:05Z']],
      }),
    );
    expect(headerRows(doc)).toEqual([
      ['Field', 'Value'],
      ['From', 'Delegate <delegate@example.org>'],
      ['To', 'Someone; Other'],
      ['Cc', 'Copy'],
      ['Date', '2025-01-02T03:04:05.000Z'],
    ]);
  });

  it('keeps a damaged compressed RTF body with a warning', async () => {
    const doc = await extract(
      buildMsg({ binaries: [[0x1009, compressedRtf('{\\rtf1 Still here.}', { crc: 1 })]] }),
    );
    expect(paragraphs(doc.blocks)).toEqual(['Still here.']);
    expect(doc.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
  });

  it('gives byte-identical JSON for the same input', async () => {
    const bytes = corpus('msg/embedded-message.msg');
    const first = toJSON(await extract(bytes), { stable: true });
    expect(toJSON(await extract(bytes), { stable: true })).toBe(first);
  });

  it('survives the fuzz target on corpus files, truncations and raw LZFu', async () => {
    for (const name of ['msg/embedded-message.msg', 'msg/rtf-fromhtml.msg', 'ole/test_outlook_msg.msg']) {
      const bytes = corpus(name);
      await expect(fuzzMsg(bytes)).resolves.toBeUndefined();
      await expect(fuzzMsg(bytes.subarray(0, bytes.length >> 1))).resolves.toBeUndefined();
    }
    await expect(fuzzMsg(compressedRtf('{\\rtf1 x}'))).resolves.toBeUndefined();
  });
});

describe('compressed RTF (MS-OXRTFCP)', () => {
  const budget = () => new Budget(DEFAULT_LIMITS);

  it('decodes the specification examples', () => {
    const first = decompressRtf(
      hex(
        '2d 00 00 00 2b 00 00 00 4c 5a 46 75 f1 c5 c7 a7 03 00 0a 00 72 63 70 67 31 32 35 42 32 0a f3 20 68 65 ' +
          '6c 09 00 20 62 77 05 b0 6c 64 7d 0a 80 0f a0',
      ),
      budget(),
    )!;
    expect(new TextDecoder().decode(first.bytes)).toBe('{\\rtf1\\ansi\\ansicpg1252\\pard hello world}\r\n');
    expect(first.damaged).toBe(false);
    const second = decompressRtf(
      hex('1a 00 00 00 1c 00 00 00 4c 5a 46 75 e2 d4 4b 51 41 00 04 20 57 58 59 5a 0d 6e 7d 01 0e b0'),
      budget(),
    )!;
    expect(new TextDecoder().decode(second.bytes)).toBe('{\\rtf1 WXYZWXYZWXYZWXYZWXYZ}');
  });

  it('reads the uncompressed MELA form', () => {
    const body = utf8('{\\rtf1 raw}');
    const bytes = new Uint8Array(16 + body.length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 12 + body.length, true);
    view.setUint32(4, body.length, true);
    view.setUint32(8, 0x414c454d, true);
    bytes.set(body, 16);
    expect(decompressRtf(bytes, budget())).toEqual({ bytes: body, damaged: false });
  });

  it('sizes output from the input, not from a lying raw size', () => {
    const result = decompressRtf(compressedRtf('{\\rtf1 x}', { rawSize: 0xffff_ffff }), budget())!;
    expect(new TextDecoder().decode(result.bytes)).toBe('{\\rtf1 x}');
    expect(result.damaged).toBe(true);
  });

  it('reports truncation, a wrong checksum and unknown types', () => {
    const whole = compressedRtf('{\\rtf1 truncated stream}');
    expect(decompressRtf(whole.subarray(0, 24), budget())?.damaged).toBe(true);
    expect(decompressRtf(compressedRtf('{\\rtf1 x}', { crc: 7 }), budget())?.damaged).toBe(true);
    const unknown = whole.slice();
    unknown[8] = 0;
    expect(decompressRtf(unknown, budget())).toBeUndefined();
    expect(decompressRtf(whole.subarray(0, 8), budget())).toBeUndefined();
  });

  it('charges output to the shared byte and ratio limits', () => {
    const repeated = hex(
      '1a 00 00 00 1c 00 00 00 4c 5a 46 75 e2 d4 4b 51 41 00 04 20 57 58 59 5a 0d 6e 7d 01 0e b0',
    );
    const tight = new Budget({ ...DEFAULT_LIMITS, totalUncompressedBytes: 10 }, { onLimit: 'throw' });
    expect(() => decompressRtf(repeated, tight)).toThrow(LimitExceededError);
    const ratio = new Budget(
      { ...DEFAULT_LIMITS, compressionRatio: 1.1, compressionRatioMinBytes: 0 },
      { onLimit: 'throw' },
    );
    expect(() => decompressRtf(repeated, ratio)).toThrow(LimitExceededError);
  });
});

describe('CFB writer', () => {
  it('round-trips storages, mini streams, regular streams and empty streams through openCfb', () => {
    const big = new Uint8Array(10_000).map((_, index) => index & 0xff);
    const entries = [
      { path: 'A', type: 'storage' as const },
      { path: 'A/small', type: 'stream' as const, data: utf8('mini sector data') },
      { path: 'A/B', type: 'storage' as const },
      { path: 'A/B/big', type: 'stream' as const, data: big },
      { path: 'empty', type: 'stream' as const, data: new Uint8Array(0) },
      ...Array.from({ length: 40 }, (_, index) => ({
        path: `s${index}`,
        type: 'stream' as const,
        data: utf16z(`stream ${index}`),
      })),
    ];
    const bytes = writeCfb(entries, new Budget(DEFAULT_LIMITS))!;
    const archive = openCfb(bytes, new Budget(DEFAULT_LIMITS));
    expect(archive.entries).toHaveLength(entries.length + 1);
    for (const entry of entries) {
      if (entry.type === 'stream') expect(archive.read(entry.path)).toEqual(entry.data);
      else expect(archive.entries.find((found) => found.path === entry.path)?.type).toBe('storage');
    }
  });

  it('writes DIFAT sectors when the FAT outgrows the header', () => {
    const large = new Uint8Array(7_500_000);
    large[large.length - 1] = 42;
    const bytes = writeCfb([{ path: 'large', type: 'stream', data: large }], new Budget(DEFAULT_LIMITS))!;
    expect(new DataView(bytes.buffer).getUint32(72, true)).toBeGreaterThan(0);
    const read = openCfb(bytes, new Budget(DEFAULT_LIMITS)).read('large');
    expect(read.length).toBe(large.length);
    expect(read[read.length - 1]).toBe(42);
  });

  it('refuses invalid trees and output beyond the byte limit', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    expect(writeCfb([{ path: 'missing/child', type: 'stream' }], budget)).toBeUndefined();
    expect(writeCfb([{ path: 'x'.repeat(32), type: 'stream' }], budget)).toBeUndefined();
    expect(
      writeCfb(
        [
          { path: 'dup', type: 'stream' },
          { path: 'dup', type: 'stream' },
        ],
        budget,
      ),
    ).toBeUndefined();
    expect(
      writeCfb(
        [
          { path: 'file', type: 'stream' },
          { path: 'file/child', type: 'stream' },
        ],
        budget,
      ),
    ).toBeUndefined();
    const small = new Budget({ ...DEFAULT_LIMITS, totalUncompressedBytes: 1_000 });
    expect(writeCfb([{ path: 'a', type: 'stream', data: new Uint8Array(10) }], small)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { CfbArchive, CfbEntry } from '../../../src/ole/index.js';
import { openCfb } from '../../../src/ole/index.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import reader, { decompressCompressedRtf } from '../../../src/readers/msg/index.js';
import { fuzzMsg } from '../../../fuzz/msg.fuzz.js';

function createContext(
  bytes: Uint8Array,
  limits: Record<string, number> = {},
  cfb?: CfbArchive,
  extractChild: ReadContext['extractChild'] = () => Promise.resolve(),
  metadata = true,
) {
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings });
  const options = { limits: budget.limits, metadata, runs: false } as ResolvedOptions;
  const out = new DocBuilder('msg', 'application/vnd.ms-outlook', budget, options);
  const ctx = { bytes, options, budget, warnings, out, path: '', cfb, extractChild } as ReadContext;
  return { ctx, finish: () => ({ doc: out.finish(), warnings: warnings.warnings }) };
}

function archive(streams: Record<string, Uint8Array>): CfbArchive {
  const entries: CfbEntry[] = [{ path: '', size: 0, type: 'root' }];
  const bytes = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(streams)) {
    let parent = path.slice(0, path.lastIndexOf('/'));
    while (parent) {
      if (!entries.some((entry) => entry.path === parent))
        entries.push({ path: parent, size: 0, type: 'storage' });
      const slash = parent.lastIndexOf('/');
      if (slash < 0) break;
      parent = parent.slice(0, slash);
    }
    entries.push({ path, size: value.length, type: 'stream' });
    bytes.set(path, value);
  }
  return { entries, read: (path) => bytes.get(path) ?? new Uint8Array(0) };
}

function archiveWithEmbeddedMessage(): CfbArchive {
  const attachmentName = '__attach_version1.0_#00000001';
  const objectStorage = `${attachmentName}/__substg1.0_3701000D`;
  const base = archive({
    [`${attachmentName}/__properties_version1.0`]: storagePropertiesLong(0x3705, 5),
    '__attach_version1.0_#00000000/__substg1.0_3707001F': utf16('note.txt\0'),
    '__attach_version1.0_#00000000/__substg1.0_37010102': new TextEncoder().encode('attachment bytes'),
    [`${attachmentName}/__substg1.0_3707001F`]: utf16('embedded.msg\0'),
  });
  const sample = openCfb(
    new Uint8Array(readFileSync(new URL('../../../../../corpus/msg/test_outlook_msg.msg', import.meta.url))),
    new Budget(resolveLimits()),
  );
  const rootProperties = sample.read('__properties_version1.0');
  const embeddedProperties = new Uint8Array(rootProperties.length - 8);
  embeddedProperties.set(rootProperties.subarray(0, 24));
  embeddedProperties.set(rootProperties.subarray(32), 24);
  const entries: CfbEntry[] = [...base.entries, { path: objectStorage, size: 0, type: 'storage' }];
  for (const entry of sample.entries) {
    if (entry.type === 'root') continue;
    const path = `${objectStorage}/${entry.path}`;
    const isProperties = entry.type === 'stream' && entry.path === '__properties_version1.0';
    entries.push({ ...entry, path, ...(isProperties ? { size: embeddedProperties.length } : {}) });
  }
  return {
    entries,
    read(path) {
      const prefix = `${objectStorage}/`;
      if (path.startsWith(prefix)) {
        const nestedPath = path.slice(prefix.length);
        return nestedPath === '__properties_version1.0' ? embeddedProperties : sample.read(nestedPath);
      }
      return base.read(path);
    },
  };
}

function utf16(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++) view.setUint16(index * 2, value.charCodeAt(index), true);
  return bytes;
}

function propertiesLong(propertyId: number, value: number): Uint8Array {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  view.setUint16(32, 0x0003, true);
  view.setUint16(34, propertyId, true);
  view.setUint32(40, value, true);
  return bytes;
}

function storagePropertiesLong(propertyId: number, value: number): Uint8Array {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 0x0003, true);
  view.setUint16(10, propertyId, true);
  view.setUint32(16, value, true);
  return bytes;
}

function compressedLiteralRtf(source: string): Uint8Array {
  const raw = new TextEncoder().encode(source);
  const payload: number[] = [];
  for (let offset = 0; offset < raw.length; offset += 8) {
    payload.push(0);
    for (const byte of raw.subarray(offset, offset + 8)) payload.push(byte);
  }
  const result = new Uint8Array(16 + payload.length);
  const view = new DataView(result.buffer);
  view.setUint32(0, 12 + payload.length, true);
  view.setUint32(4, raw.length, true);
  view.setUint32(8, 0x75465a4c, true);
  result.set(payload, 16);
  view.setUint32(12, crc32(new Uint8Array(result.buffer, 16)), true);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return crc >>> 0;
}

describe('MSG reader', () => {
  it('reads subject, sender, recipients, and PR_BODY from the licensed Outlook sample', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../../corpus/msg/test_outlook_msg.msg', import.meta.url)),
    );
    const { ctx, finish } = createContext(bytes);
    await reader.read(ctx);
    const { doc } = finish();
    expect(doc.format).toBe('msg');
    expect(doc.metadata.title).toBe('Test Email Message');
    expect(doc.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'This is the body of the test email message' }),
    );
    expect(JSON.stringify(doc.blocks)).toContain('test.recipient@example.com');
  });

  it('prefers Unicode properties and decodes ANSI string streams using PR_INTERNET_CPID', async () => {
    const cfb = archive({
      '__substg1.0_0037001F': utf16('Unicode subject\0'),
      '__substg1.0_0037001E': new Uint8Array([65, 78, 83, 73, 0]),
      '__substg1.0_1000001E': new Uint8Array([0xc3, 0xa9, 0]),
      '__properties_version1.0': propertiesLong(0x3fde, 65001),
    });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    const { doc } = finish();
    expect(doc.metadata.title).toBe('Unicode subject');
    expect(doc.blocks).toContainEqual(expect.objectContaining({ kind: 'paragraph', text: 'é' }));
  });

  it('decodes RFC 2047 encoded words in transport headers', async () => {
    const cfb = archive({ '__substg1.0_0037001F': utf16('=?UTF-8?B?5pel5pys?=\0') });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    expect(finish().doc.metadata.title).toBe('日本');
  });

  it('keeps From, To and Cc headers out when metadata is disabled', async () => {
    const cfb = archive({
      '__substg1.0_0037001F': utf16('Subject\0'),
      '__substg1.0_0C1F001F': utf16('sender@example.com\0'),
      '__substg1.0_0E04001F': utf16('to@example.com\0'),
      '__substg1.0_0E03001F': utf16('cc@example.com\0'),
    });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb, undefined, false);
    await reader.read(ctx);
    const table = finish().doc.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' && table.rows.flat().map(({ text }) => text)).toEqual([
      'Field',
      'Value',
      'Subject',
      'Subject',
    ]);
  });

  it('reads recipient type and address from an 8-byte recipient property stream', async () => {
    const cfb = archive({
      '__recip_version1.0_#00000000/__properties_version1.0': storagePropertiesLong(0x0c15, 1),
      '__recip_version1.0_#00000000/__substg1.0_3003001F': utf16('recipient@example.com\0'),
    });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    const table = finish().doc.blocks.find((block) => block.kind === 'table');
    expect(table?.kind === 'table' && table.rows.flat().map(({ text }) => text)).toContain(
      'recipient@example.com',
    );
  });

  it('decodes a compressed RTF literal stream through the RTF reader', async () => {
    const rtf = String.raw`{\rtf1\ansi compressed body\par}`;
    const cfb = archive({ '__substg1.0_10090102': compressedLiteralRtf(rtf) });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    expect(finish().doc.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'compressed body' }),
    );
  });

  it('decodes the Microsoft compressed-RTF example with dictionary references', () => {
    const sample = new Uint8Array([
      0x2d, 0, 0, 0, 0x2b, 0, 0, 0, 0x4c, 0x5a, 0x46, 0x75, 0xf1, 0xc5, 0xc7, 0xa7, 0x03, 0x00, 0x0a, 0x00,
      0x72, 0x63, 0x70, 0x67, 0x31, 0x32, 0x35, 0x42, 0x32, 0x0a, 0xf3, 0x20, 0x68, 0x65, 0x6c, 0x09, 0x00,
      0x20, 0x62, 0x77, 0x05, 0xb0, 0x6c, 0x64, 0x7d, 0x0a, 0x80, 0x0f, 0xa0,
    ]);
    const { ctx } = createContext(new Uint8Array(0));
    expect(new TextDecoder().decode(decompressCompressedRtf(sample, ctx.budget))).toContain('\\rtf1');
  });

  it('uses the HTML property when plain text is absent', async () => {
    const cfb = archive({
      '__substg1.0_10130102': new TextEncoder().encode('<html><p>HTML body</p></html>'),
    });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    expect(finish().doc.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'HTML body' }),
    );
  });

  it('falls back when the runtime does not support the MSG HTML code-page label', async () => {
    const html = new Uint8Array([
      ...new TextEncoder().encode('<p>caf'),
      0xe9,
      ...new TextEncoder().encode('</p>'),
    ]);
    const cfb = archive({
      '__substg1.0_10130102': html,
      '__properties_version1.0': propertiesLong(0x3fde, 437),
    });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    const { doc, warnings } = finish();
    expect(doc.blocks).toContainEqual(expect.objectContaining({ kind: 'paragraph', text: 'café' }));
    expect(warnings.map(({ code }) => code)).toContain('ENCODING_GUESSED');
  });

  it('de-encapsulates HTML from compressed RTF and does not emit RTF controls', async () => {
    const rtf = String.raw`{\rtf1\ansi\fromhtml1{\*\htmltag1}<p>Encapsulated HTML</p>}{\htmlrtf hidden controls\htmlrtf0}`;
    const cfb = archive({ '__substg1.0_10090102': compressedLiteralRtf(rtf) });
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb);
    await reader.read(ctx);
    const { doc } = finish();
    expect(doc.blocks).toContainEqual(
      expect.objectContaining({ kind: 'paragraph', text: 'Encapsulated HTML' }),
    );
    expect(JSON.stringify(doc.blocks)).not.toContain('\\fromhtml');
    expect(JSON.stringify(doc.blocks)).not.toContain('hidden controls');
  });

  it('preflights declared LZFu output before allocating it', () => {
    const bomb = new Uint8Array(16);
    const view = new DataView(bomb.buffer);
    view.setUint32(0, 12, true);
    view.setUint32(4, 0xffff_ffff, true);
    view.setUint32(8, 0x75465a4c, true);
    const { ctx } = createContext(new Uint8Array(0), { totalUncompressedBytes: 32 });
    expect(() => decompressCompressedRtf(bomb, ctx.budget)).not.toThrow();
    expect(ctx.budget.truncated).toBe(true);
    expect(ctx.budget.warnings.warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });

  it('emits binary and embedded MSG attachments as bounded children', async () => {
    const cfb = archiveWithEmbeddedMessage();
    const children: Array<{ name: string; bytes: Uint8Array; mimeType?: string }> = [];
    const { ctx, finish } = createContext(new Uint8Array(0), {}, cfb, (name, bytes, hint) => {
      children.push({ name, bytes, mimeType: hint?.mimeType });
      return Promise.resolve();
    });
    await reader.read(ctx);
    const { doc, warnings } = finish();
    expect(children.map(({ name }) => name).sort()).toEqual(['embedded.msg', 'note.txt']);
    const embedded = children.find(({ name }) => name === 'embedded.msg')!.bytes;
    const embeddedCfb = openCfb(embedded, new Budget(resolveLimits()));
    const cfbHeader = new DataView(embedded.buffer, embedded.byteOffset, embedded.byteLength);
    const miniFatStart = cfbHeader.getUint32(60, true);
    const miniFatSectors = cfbHeader.getUint32(64, true);
    const miniFatOffset = (miniFatStart + 1) * 512;
    const usedMiniFatEntries = embeddedCfb.entries
      .filter((entry) => entry.type === 'stream' && entry.size > 0 && entry.size < 4096)
      .reduce((total, entry) => total + Math.ceil(entry.size / 64), 0);
    const miniFat = new DataView(embedded.buffer, embedded.byteOffset + miniFatOffset, miniFatSectors * 512);
    for (let index = usedMiniFatEntries; index < (miniFatSectors * 512) / 4; index++)
      expect(miniFat.getUint32(index * 4, true)).toBe(0xffff_ffff);
    const rebuiltProperties = embeddedCfb.read('__properties_version1.0');
    const sampleCfb = openCfb(
      new Uint8Array(
        readFileSync(new URL('../../../../../corpus/msg/test_outlook_msg.msg', import.meta.url)),
      ),
      new Budget(resolveLimits()),
    );
    const rootProperties = sampleCfb.read('__properties_version1.0');
    const originalEmbeddedProperties = new Uint8Array(rootProperties.length - 8);
    originalEmbeddedProperties.set(rootProperties.subarray(0, 24));
    originalEmbeddedProperties.set(rootProperties.subarray(32), 24);
    const counters = new DataView(
      rebuiltProperties.buffer,
      rebuiltProperties.byteOffset,
      rebuiltProperties.byteLength,
    );
    const embeddedCounters = new DataView(
      originalEmbeddedProperties.buffer,
      originalEmbeddedProperties.byteOffset,
      originalEmbeddedProperties.byteLength,
    );
    for (const offset of [0, 4, 8, 12, 16, 20])
      expect(counters.getUint32(offset, true)).toBe(embeddedCounters.getUint32(offset, true));
    expect(rebuiltProperties.subarray(32)).toEqual(originalEmbeddedProperties.subarray(24));
    expect(new TextDecoder('utf-16le').decode(embeddedCfb.read('__substg1.0_0037001F'))).toContain(
      'Test Email Message',
    );
    expect(children.find(({ name }) => name === 'embedded.msg')?.mimeType).toBe('application/vnd.ms-outlook');
    const embeddedContext = createContext(embedded);
    await reader.read(embeddedContext.ctx);
    expect(embeddedContext.finish().doc.metadata.created).toBeDefined();
    expect(doc.features.hasEmbeddedFiles).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('handles hostile attachment storage loops without extracting the parent MSG bytes', async () => {
    const cfb = archive({
      '__attach_version1.0_#00000000/__attach_version1.0_#00000000/__substg1.0_37010102': new Uint8Array([1]),
    });
    const children: Uint8Array[] = [];
    const { ctx, finish } = createContext(new Uint8Array([9, 8, 7]), {}, cfb, (_name, bytes) => {
      children.push(bytes);
      return Promise.resolve();
    });
    await reader.read(ctx);
    expect(children).toEqual([]);
    expect(finish().warnings.map(({ code }) => code)).toContain('UNREADABLE_PART');
  });

  it('runs the bounded fuzz entry point on arbitrary and real MSG input', async () => {
    await fuzzMsg(new Uint8Array([0, 1, 2, 3, 4]));
    await fuzzMsg(
      new Uint8Array(
        readFileSync(new URL('../../../../../corpus/msg/test_outlook_msg.msg', import.meta.url)),
      ),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createExtractor } from '../../src/core/extract.js';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader } from '../../src/core/reader.js';
import type { Block } from '../../src/core/model.js';
import type { CfbArchive, CfbEntry } from '../../src/ole/index.js';
import txt from '../../src/readers/txt/index.js';
import markdown from '../../src/readers/markdown/index.js';
import json from '../../src/readers/json/index.js';
import xml from '../../src/readers/xml/index.js';
import yaml from '../../src/readers/yaml/index.js';
import ndjson from '../../src/readers/ndjson/index.js';
import ics from '../../src/readers/ics/index.js';
import vcf from '../../src/readers/vcf/index.js';
import { srt, vtt } from '../../src/readers/subtitles/index.js';
import source from '../../src/readers/source/index.js';
import eml from '../../src/readers/eml/index.js';
import mbox from '../../src/readers/mbox/index.js';
import msg from '../../src/readers/msg/index.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function registry(extra: Reader[] = []): ReaderRegistry {
  const builtins = [txt, markdown, json, xml, yaml, ndjson, ics, vcf, srt, vtt, source, eml, mbox, msg];
  const result = new ReaderRegistry();
  const replacements = new Set(extra.map(({ id }) => id));
  const readers = [...builtins.filter(({ id }) => !replacements.has(id)), ...extra];
  for (const reader of readers) {
    result.add({
      id: reader.id,
      mimeTypes: reader.mimeTypes,
      load: () => Promise.resolve(reader),
    });
  }
  return result;
}

function msgAttachmentReader(): Reader {
  const storage = '__attach_version1.0_#00000000';
  const filenamePath = `${storage}/__substg1.0_3707001F`;
  const dataPath = `${storage}/__substg1.0_37010102`;
  const added: CfbEntry[] = [
    { path: storage, size: 0, type: 'storage' },
    { path: filenamePath, size: 18, type: 'stream' },
    { path: dataPath, size: 19, type: 'stream' },
  ];
  const contents = new Map<string, Uint8Array>([
    [filenamePath, new Uint8Array([...'note.txt\0'].flatMap((character) => [character.charCodeAt(0), 0]))],
    [dataPath, bytes('MSG attachment text')],
  ]);
  return {
    ...msg,
    async read(ctx) {
      const original = ctx.cfb;
      if (!original) throw new Error('The integration fixture was expected to resolve as CFB.');
      const cfb: CfbArchive = {
        entries: [...original.entries, ...added],
        read(path) {
          return contents.get(path) ?? original.read(path);
        },
      };
      await msg.read({ ...ctx, cfb });
    },
  };
}

function fixture(path: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../corpus/${path}`, import.meta.url)));
}

describe('Package B readers through the extraction pipeline', () => {
  it('loads named and default reader exports through a test-local registry', async () => {
    const readers = registry();
    for (const id of [
      'txt',
      'markdown',
      'json',
      'xml',
      'yaml',
      'ndjson',
      'ics',
      'vcf',
      'srt',
      'vtt',
      'source',
      'eml',
      'mbox',
      'msg',
    ])
      expect(readers.load(id)).toBeDefined();

    const [plain, markdownDoc, jsonDoc, xmlDoc] = await Promise.all([
      createExtractor(readers)(bytes('plain text'), { format: 'txt' }),
      createExtractor(readers)(bytes('# Heading'), { format: 'markdown' }),
      createExtractor(readers)(bytes('{"value":1}'), { format: 'json' }),
      createExtractor(readers)(bytes('<root>xml</root>'), { format: 'xml' }),
    ]);
    expect(plain.format).toBe('txt');
    expect(markdownDoc.format).toBe('markdown');
    expect(jsonDoc.format).toBe('json');
    expect(xmlDoc.format).toBe('xml');
  });

  it('prefixes nested JSON and XML locations once with the child path', async () => {
    const parent: Reader = {
      id: 'integration-root',
      mimeTypes: ['application/x-integration-root'],
      async read(ctx) {
        await ctx.extractChild('payload.json', bytes('{"item":{"value":"json child"}}'));
        await ctx.extractChild('data.xml', bytes('<root><item>xml child</item></root>'));
      },
    };
    const extract = createExtractor(registry([parent]));
    const doc = await extract(bytes('root'), { format: parent.id });
    expect(doc.children.map(({ path, status }) => [path, status])).toEqual([
      ['payload.json', 'extracted'],
      ['data.xml', 'extracted'],
    ]);
    const jsonChild = doc.children[0]!.document!;
    const xmlChild = doc.children[1]!.document!;
    expect(jsonChild.format).toBe('json');
    expect(jsonChild.blocks.map((block) => block.loc.path)).toContain('payload.json/$.item.value');
    expect(xmlChild.format).toBe('xml');
    expect(xmlChild.blocks.map((block) => block.loc.path)).toContain('data.xml/root/item');
    expect(JSON.stringify([jsonChild, xmlChild])).not.toContain('payload.json/payload.json');
    expect(JSON.stringify([jsonChild, xmlChild])).not.toContain('data.xml/data.xml');
  });

  it('applies transforms and callbacks to real TXT blocks under the shared output budget', async () => {
    const onBlock = vi.fn<(block: Block) => void>();
    const doc = await createExtractor(registry())(bytes('drop\n\nkeep\n\nexcess'), {
      format: 'txt',
      limits: { outputChars: 4 },
      onBlock,
      transform: (block) => (block.kind === 'paragraph' && block.text === 'drop' ? null : block),
    });
    expect(doc.blocks).toMatchObject([{ kind: 'paragraph', text: 'keep' }]);
    expect(doc.stats.truncated).toBe(true);
    expect(
      onBlock.mock.calls.map(([block]) => (block.kind === 'paragraph' ? block.text : block.kind)),
    ).toEqual(['keep']);
  });

  it('isolates an invalid EML attachment while preserving attachment order and privacy policy', async () => {
    const message = [
      'From: Private Sender <sender@example.invalid>',
      'To: Private Reader <reader@example.invalid>',
      'Subject: Attachment integration',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="parts"',
      '',
      '--parts',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Visible body marker.',
      '--parts',
      'Content-Type: text/plain; name="first.txt"',
      'Content-Disposition: attachment; filename="first.txt"',
      'Content-Transfer-Encoding: base64',
      '',
      'Zmlyc3QgYXR0YWNobWVudA==',
      '--parts',
      'Content-Type: application/octet-stream; name="broken.bin"',
      'Content-Disposition: attachment; filename="broken.bin"',
      'Content-Transfer-Encoding: base64',
      '',
      '0M8R4KGxGuE=',
      '--parts--',
      '',
    ].join('\r\n');
    const doc = await createExtractor(registry())(bytes(message), { format: 'eml', metadata: false });
    expect(doc.children.map(({ name, status }) => [name, status])).toEqual([
      ['first.txt', 'extracted'],
      ['broken.bin', 'failed'],
    ]);
    expect(doc.children[0]!.document?.blocks).toMatchObject([
      { kind: 'paragraph', text: 'first attachment' },
    ]);
    expect(JSON.stringify(doc)).toContain('Visible body marker.');
    expect(JSON.stringify(doc)).not.toContain('sender@example.invalid');
    expect(JSON.stringify(doc)).not.toContain('reader@example.invalid');

    const listed = await createExtractor(registry())(bytes(message), {
      format: 'eml',
      metadata: false,
      children: 'list',
    });
    expect(listed.children.map(({ status }) => status)).toEqual(['listed', 'listed']);
    const skipped = await createExtractor(registry())(bytes(message), {
      format: 'eml',
      metadata: false,
      children: 'skip',
    });
    expect(skipped.children).toEqual([]);
  });

  it('keeps MBOX message child order and applies MSG metadata privacy through createExtractor', async () => {
    const mboxDoc = await createExtractor(registry())(fixture('mbox/mboxrd-two-messages.mbox'), {
      format: 'mbox',
    });
    expect(mboxDoc.children.map(({ name, status }) => [name, status])).toEqual([
      ['message-1.eml', 'extracted'],
      ['message-2.eml', 'extracted'],
    ]);
    expect(JSON.stringify(mboxDoc.children[0]!.document)).toContain('MBOX MESSAGE ONE');
    expect(JSON.stringify(mboxDoc.children[1]!.document)).toContain('MBOX MESSAGE TWO');

    const msgDoc = await createExtractor(registry())(fixture('msg/test_outlook_msg.msg'), {
      format: 'msg',
      metadata: false,
    });
    const serialized = JSON.stringify(msgDoc);
    expect(msgDoc.metadata.title).toBe('Test Email Message');
    expect(serialized).not.toContain('test.recipient@example.com');
    expect(serialized).not.toContain('test.sender@example.com');
  });

  it.todo('routes message/rfc822 MBOX children through EML, including metadata privacy');

  it('applies MSG attachment extract/list/skip policies through the real reader and pipeline', async () => {
    const input = fixture('msg/test_outlook_msg.msg');
    const readers = registry([msgAttachmentReader()]);
    const extract = createExtractor(readers);
    const extracted = await extract(input);
    expect(extracted.children.map(({ name, status }) => [name, status])).toEqual([['note.txt', 'extracted']]);
    expect(extracted.children[0]!.document?.blocks).toMatchObject([
      { kind: 'paragraph', text: 'MSG attachment text' },
    ]);

    const listed = await extract(input, { children: 'list' });
    expect(listed.children.map(({ name, status }) => [name, status])).toEqual([['note.txt', 'listed']]);
    const skipped = await extract(input, { children: 'skip' });
    expect(skipped.children).toEqual([]);
  });

  it('propagates caller abort through the public extraction pipeline', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createExtractor(registry())(bytes('never read'), { format: 'txt', signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'ABORTED' });
  });
});

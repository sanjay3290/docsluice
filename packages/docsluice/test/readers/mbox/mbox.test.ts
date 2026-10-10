import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detect } from '../../../src/detect/detect.js';
import { extract } from '../../../src/core/extract.js';
import type { DocsluiceDocument } from '../../../src/core/model.js';
import { mboxReader } from '../../../src/readers/mbox/index.js';

const corpus = () =>
  new Uint8Array(readFileSync(new URL('../../../../../corpus/mbox/mailbox.mbox', import.meta.url)));
const text = (value: string) => new TextEncoder().encode(value);
const bodies = (doc: DocsluiceDocument) =>
  doc.children.map((child) =>
    (child.document?.blocks ?? [])
      .filter((block) => block.kind === 'paragraph')
      .map((block) => ('text' in block ? block.text : '')),
  );

describe('MBOX reader', () => {
  it('gives one EML child per message, with mboxrd quoting undone', async () => {
    expect(mboxReader.id).toBe('mbox');
    const doc = await extract(corpus());
    expect(doc.format).toBe('mbox');
    expect(doc.mimeType).toBe('application/mbox');
    expect(doc.blocks).toEqual([]);
    expect(doc.children.map((child) => [child.path, child.status, child.document?.format])).toEqual([
      ['message-1.eml', 'extracted', 'eml'],
      ['message-2.eml', 'extracted', 'eml'],
      ['message-3.eml', 'extracted', 'eml'],
    ]);
    expect(doc.children.map((child) => child.document?.metadata.title)).toEqual([
      'Field plan',
      'Re: Field plan',
      'Readings',
    ]);
    expect(bodies(doc)[0]).toEqual([
      'The tide survey starts at dawn.\nFrom the north jetty we walk south.\n>From a quoted reply, still quoted once.\nBring the gauge.\nFrom here on the line is body text, not an envelope.',
    ]);
    expect(doc.children[2]!.document!.children[0]!.path).toBe('message-3.eml/readings.csv');
  });

  it('lists messages with children: list and adds nothing with children: skip', async () => {
    const listed = await extract(corpus(), { children: 'list' });
    expect(listed.children.map((child) => [child.name, child.status, child.mimeType])).toEqual([
      ['message-1.eml', 'listed', 'message/rfc822'],
      ['message-2.eml', 'listed', 'message/rfc822'],
      ['message-3.eml', 'listed', 'message/rfc822'],
    ]);
    expect(listed.children.every((child) => (child.sizeBytes ?? 0) > 100)).toBe(true);
    expect((await extract(corpus(), { children: 'skip' })).children).toEqual([]);
  });

  it('splits CRLF mailboxes and keeps the last message without a trailing blank line', async () => {
    const mailbox =
      'From a\r\nFrom: a@example.test\r\nSubject: one\r\n\r\nFirst\r\n\r\nFrom b\r\nFrom: b@example.test\r\nSubject: two\r\n\r\nSecond';
    const doc = await extract(text(mailbox));
    expect(doc.format).toBe('mbox');
    expect(bodies(doc)).toEqual([['First'], ['Second']]);
    const lf = await extract(
      text('From a\nFrom: a@example.test\nSubject: one\n\nOne\n\nFrom b\nFrom: b\nSubject: two\n\nTwo\n'),
    );
    expect(bodies(lf)).toEqual([['One'], ['Two']]);
  });

  it('warns when a forced mailbox has no envelope line, and stops at zipEntries', async () => {
    const empty = await extract(text('Just text.\n'), { format: 'mbox' });
    expect(empty.warnings.map((warning) => warning.code)).toEqual(['UNREADABLE_PART']);
    const many = Array.from({ length: 5 }, (_, index) => `From x\nFrom: x\nSubject: ${index}\n\nm\n`).join(
      '\n',
    );
    // In list mode only the messages count; extracted messages also count their MIME parts.
    const limited = await extract(text(many), { limits: { zipEntries: 2 }, children: 'list' });
    expect(limited.children).toHaveLength(2);
    expect(limited.stats.truncated).toBe(true);
    const tight = await extract(text(many), { limits: { totalUncompressedBytes: 40 } });
    expect(tight.children.length).toBeLessThan(5);
  });

  it('is detected from its envelope line and header block, or its name', async () => {
    expect((await detect(corpus())).format).toBe('mbox');
    expect((await detect(text('From the desk of the editor.\nNothing else.'))).format).toBe('txt');
    expect((await detect(text('From x\nnot a header'))).format).not.toBe('mbox');
    expect((await detect(text('From x'))).format).not.toBe('mbox');
    expect(
      (await extract(text('From x\nFrom: x\nSubject: y\n\nz\n'), { filename: 'archive.mbox' })).format,
    ).toBe('mbox');
  });
});

describe('PST (ADR 0015)', () => {
  it('is detected and refused', async () => {
    const pst = new Uint8Array(512);
    pst.set([0x21, 0x42, 0x44, 0x4e, 0, 0, 0, 0, 0x53, 0x4d]);
    expect((await detect(pst)).format).toBe('pst');
    await expect(extract(pst)).rejects.toMatchObject({ code: 'UNSUPPORTED_FORMAT' });
  });
});

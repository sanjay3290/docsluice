import { describe, expect, it } from 'vitest';
import {
  decodeMimeText,
  decodeTransferEncoding,
  parseContentType,
  parseHeaders,
  parseMime,
} from '../../src/mime/index.js';
import { Budget } from '../../src/core/budget.js';
import { LimitExceededError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';

describe('MIME core', () => {
  it('unfolds headers and decodes adjacent encoded words', () => {
    const headers = parseHeaders(
      'Subject: =?UTF-8?Q?Caf=C3=A9?=\r\n =?UTF-8?B?4pyT?=\r\nFrom: A <a@example.test>\r\n',
      new Budget(DEFAULT_LIMITS),
    );
    expect(headers.get('subject')).toBe('Café✓');
    expect(headers.get('from')).toBe('A <a@example.test>');
    expect(
      parseHeaders('Subject: =?UTF-8?Q?hello?= world\r\n', new Budget(DEFAULT_LIMITS)).get('subject'),
    ).toBe('hello world');
  });

  it('joins RFC 2231 continuations and decodes transfer encodings', () => {
    const params = parseContentType("application/octet-stream; name*=utf-8''long%20caf%C3%A9.bin");
    expect(params.parameters.get('name')).toBe('long café.bin');
    expect([...decodeTransferEncoding('AQIDBAUG', 'base64', 64)]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      new TextDecoder().decode(decodeTransferEncoding('QP BODY: caf=C3=A9.', 'quoted-printable', 64)),
    ).toBe('QP BODY: café.');
  });

  it('walks multipart bodies iteratively and reports incomplete boundaries safely', () => {
    const budget = new Budget(DEFAULT_LIMITS);
    const message = parseMime(
      new TextEncoder().encode(
        'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nfirst\r\n--b\r\nContent-Type: text/plain\r\n\r\nsecond\r\n--b--\r\n',
      ),
      budget,
    );
    expect(message.parts[0]?.parts.map((part) => decodeMimeText(part))).toEqual(['first', 'second']);
    const incomplete = parseMime(
      new TextEncoder().encode(
        'Content-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain\r\n\r\npartial',
      ),
      new Budget(DEFAULT_LIMITS),
    );
    expect(incomplete.parts[0]?.parts.map((part) => decodeMimeText(part))).toEqual(['partial']);
    expect(incomplete.incomplete).toBe(true);
  });

  it('keeps body bytes after the first empty line when the root or MIME part has no headers', () => {
    const root = parseMime(new TextEncoder().encode('\r\nheaderless root body'), new Budget(DEFAULT_LIMITS));
    expect(root.parts[0]?.contentType.value).toBe('text/plain');
    expect(decodeMimeText(root.parts[0]!)).toBe('headerless root body');

    const lfRoot = parseMime(new TextEncoder().encode('\nLF headerless body'), new Budget(DEFAULT_LIMITS));
    expect(decodeMimeText(lfRoot.parts[0]!)).toBe('LF headerless body');

    const nested = parseMime(
      new TextEncoder().encode(
        'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\nheaderless child body\r\n--b--\r\n',
      ),
      new Budget(DEFAULT_LIMITS),
    );
    expect(decodeMimeText(nested.parts[0]!.parts[0]!)).toBe('headerless child body');
  });

  it('accepts an EOF-terminated multipart closing delimiter', () => {
    const message = parseMime(
      new TextEncoder().encode(
        'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nEOF body\r\n--b--',
      ),
      new Budget(DEFAULT_LIMITS),
    );
    expect(message.incomplete).toBe(false);
    expect(decodeMimeText(message.parts[0]!.parts[0]!)).toBe('EOF body');
  });

  it('stops nested multipart expansion at the configured XML-depth budget', () => {
    let source = 'Content-Type: text/plain\r\n\r\nleaf\r\n';
    for (let index = 0; index < 1000; index++) {
      source = `Content-Type: multipart/mixed; boundary=b${index}\r\n\r\n--b${index}\r\n${source}--b${index}--\r\n`;
    }
    const budget = new Budget({ ...DEFAULT_LIMITS, xmlDepth: 8 });
    const message = parseMime(new TextEncoder().encode(source), budget);
    expect(message.incomplete).toBe(true);
    expect(budget.warnings.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
  });

  it('caps base64 decoding without allocating from encoded payload declarations', () => {
    expect(decodeTransferEncoding('A'.repeat(1_000_000), 'base64', 32).length).toBe(32);
  });

  it('bounds multipart sibling counts with the shared entry allowance', () => {
    let source = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n';
    for (let index = 0; index < 20; index++) {
      source += `--b\r\nContent-Type: text/plain\r\n\r\npart ${index}\r\n`;
    }
    source += '--b--\r\n';
    const budget = new Budget({ ...DEFAULT_LIMITS, zipEntries: 5 });
    const message = parseMime(new TextEncoder().encode(source), budget);
    expect(message.parts[0]?.parts.length).toBeLessThanOrEqual(5);
    expect(message.incomplete).toBe(true);
  });

  it('throws the core limit error when entry exhaustion is configured to throw', () => {
    const bytes = new TextEncoder().encode('Content-Type: text/plain\r\n\r\nbody');
    const budget = new Budget({ ...DEFAULT_LIMITS, zipEntries: 0 }, { onLimit: 'throw' });
    expect(() => parseMime(bytes, budget)).toThrow(LimitExceededError);
  });

  it('caps oversized headers and rejects invalid multipart boundaries', () => {
    const tooLargeHeader = new TextEncoder().encode(`Subject: ${'x'.repeat(1_048_600)}\r\n\r\nbody`);
    const headerBudget = new Budget(DEFAULT_LIMITS);
    const headerMessage = parseMime(tooLargeHeader, headerBudget);
    expect(headerMessage.incomplete).toBe(true);
    expect(headerBudget.warnings.warnings.map((warning) => warning.code)).toContain('UNREADABLE_PART');
    expect(JSON.stringify(headerBudget.warnings.warnings)).not.toContain('x'.repeat(64));

    const badBoundary = parseMime(
      new TextEncoder().encode(
        `Content-Type: multipart/mixed; boundary="${'x'.repeat(71)}"\r\n\r\n--${'x'.repeat(71)}\r\nContent-Type: text/plain\r\n\r\nbody\r\n`,
      ),
      new Budget(DEFAULT_LIMITS),
    );
    expect(badBoundary.incomplete).toBe(true);
    expect(badBoundary.parts[0]?.parts).toHaveLength(0);
  });

  it('bounds malformed RFC 2047 word scanning to a linear pass', () => {
    const source = `Subject: ${'=?'.repeat(50_000)}\r\n`;
    const started = performance.now();
    const headers = parseHeaders(source, new Budget(DEFAULT_LIMITS));
    expect(headers.has('subject')).toBe(true);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('preflights decoded MIME bytes and charges only the bounded output', () => {
    const source = `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${'A'.repeat(400)}`;
    const budget = new Budget({ ...DEFAULT_LIMITS, totalUncompressedBytes: 12 });
    const message = parseMime(new TextEncoder().encode(source), budget);
    expect(message.parts[0]?.bytes?.length).toBe(12);
    expect(budget.totalUncompressedBytes).toBe(12);
    expect(message.incomplete).toBe(true);
    expect(budget.warnings.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
  });

  it('throws before decoding when the shared uncompressed allowance is exhausted', () => {
    const source = `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n${'A'.repeat(400)}`;
    const budget = new Budget({ ...DEFAULT_LIMITS, totalUncompressedBytes: 12 }, { onLimit: 'throw' });
    expect(() => parseMime(new TextEncoder().encode(source), budget)).toThrow(LimitExceededError);
    expect(budget.totalUncompressedBytes).toBe(0);
  });

  it('balances multipart depth when the caller aborts while nested parts are pending', () => {
    let source = 'Content-Type: text/plain\r\n\r\nleaf\r\n';
    for (let index = 0; index < 8; index++) {
      source = `Content-Type: multipart/mixed; boundary=b${index}\r\n\r\n--b${index}\r\n${source}--b${index}--\r\n`;
    }
    const controller = new AbortController();
    const budget = new Budget({ ...DEFAULT_LIMITS, xmlDepth: 8 }, { signal: controller.signal });
    const originalTick = budget.tick.bind(budget);
    const originalEnter = budget.enterDepth.bind(budget);
    let ticks = 0;
    let depthEnters = 0;
    budget.tick = () => {
      originalTick();
      if (++ticks === 500) controller.abort('stop MIME walk');
    };
    budget.enterDepth = (kind) => {
      depthEnters++;
      return originalEnter(kind);
    };
    expect(() => parseMime(new TextEncoder().encode(source), budget)).toThrow();
    expect(depthEnters).toBeGreaterThan(0);
    for (let index = 0; index < 8; index++) {
      expect(budget.enterDepth('xml')).toBe(true);
    }
    expect(budget.enterDepth('xml')).toBe(false);
    budget.exitDepth('xml');
    for (let index = 0; index < 8; index++) budget.exitDepth('xml');
  });

  it('balances depth when an onLimit throw interrupts nested parsing', () => {
    const source =
      'Content-Type: multipart/mixed; boundary=outer\r\n\r\n--outer\r\nContent-Type: multipart/mixed; boundary=inner\r\n\r\n--inner--\r\n--outer--\r\n';
    const budget = new Budget({ ...DEFAULT_LIMITS, xmlDepth: 1 }, { onLimit: 'throw' });
    expect(() => parseMime(new TextEncoder().encode(source), budget)).toThrow(LimitExceededError);
    expect(budget.enterDepth('xml')).toBe(true);
    budget.exitDepth('xml');
  });
});

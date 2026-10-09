import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readEml, reader } from '../../../src/readers/eml/index.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { Limits } from '../../../src/core/limits.js';

const options = (
  metadata: boolean,
  limits = DEFAULT_LIMITS,
  onLimit: 'truncate' | 'throw' = 'truncate',
): ResolvedOptions => ({
  limits,
  onLimit,
  strict: false,
  metadata,
  children: 'list',
  childBytes: false,
  runs: false,
  revisions: 'accept',
  includeHidden: false,
  formulas: false,
});

async function readEmail(
  source: string | Uint8Array,
  includeMetadata = true,
  limits: Partial<Limits> = {},
  quotedReplies: 'keep' | 'drop' = 'keep',
  onLimit: 'truncate' | 'throw' = 'truncate',
) {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { onLimit });
  const warnings = new WarningSink();
  const opts = options(includeMetadata, budget.limits, onLimit);
  const out = new DocBuilder('eml', 'message/rfc822', budget, opts);
  const children: Array<{ name: string; bytes: Uint8Array; mimeType?: string }> = [];
  const ctx: ReadContext = {
    bytes: typeof source === 'string' ? new TextEncoder().encode(source) : source,
    options: opts,
    budget,
    warnings,
    out,
    path: '',
    extractChild: (name, bytes, hint) =>
      Promise.resolve().then(() => {
        children.push({ name, bytes, mimeType: hint?.mimeType });
        out.addChild({
          name,
          path: name,
          status: 'listed',
          sizeBytes: bytes.length,
          mimeType: hint?.mimeType,
        });
      }),
  };
  if (quotedReplies === 'keep') await reader.read(ctx);
  else await readEml(ctx, quotedReplies);
  return { document: out.finish(), children };
}

describe('EML reader', () => {
  it('prefers plain text in multipart/alternative and preserves header fields', async () => {
    const { document: result } = await readEmail(
      'From: Alice <alice@example.test>\r\nTo: Bob <bob@example.test>\r\nSubject: Hello\r\nDate: Tue, 6 Oct 2026 09:30:00 +0000\r\nContent-Type: multipart/alternative; boundary=x\r\n\r\n--x\r\nContent-Type: text/html\r\n\r\n<b>HTML ALTERNATIVE MARKER</b>\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPLAIN PREFERENCE MARKER\r\n--x--\r\n',
    );
    expect(JSON.stringify(result.blocks)).toContain('PLAIN PREFERENCE MARKER');
    expect(JSON.stringify(result.blocks)).not.toContain('HTML ALTERNATIVE MARKER');
    expect(result.metadata.title).toBe('Hello');
    expect(result.blocks[0]?.kind).toBe('table');
  });

  it('removes personal addresses from output and metadata when metadata is disabled', async () => {
    const { document: result } = await readEmail(
      'From: Private Sender <private.sender@example.test>\r\nTo: Private Reader <private.reader@example.test>\r\nCc: private.cc@example.test\r\nSubject: Private test\r\n\r\nBody\r\n',
      false,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('private.sender@example.test');
    expect(serialized).not.toContain('private.reader@example.test');
    expect(serialized).not.toContain('private.cc@example.test');
    expect(result.metadata.title).toBe('Private test');
  });

  it('reads reviewed encoded-header and RFC 2231 fixtures without corrupting their text or names', async () => {
    const encoded = readFileSync(new URL('../../../../../corpus/eml/encoded-iso8859-1.eml', import.meta.url));
    const { document } = await readEmail(encoded);
    expect(document.metadata.title).toContain('Crème brûlée');
    expect(JSON.stringify(document.blocks)).toContain('Crème brûlée body marker.');

    const attachment = readFileSync(
      new URL('../../../../../corpus/eml/rfc2231-qp-base64.eml', import.meta.url),
    );
    const extracted = await readEmail(attachment);
    expect(JSON.stringify(extracted.document.blocks)).toContain('QP BODY: café.');
    expect(extracted.children.map((child) => child.name)).toContain('long café report.bin');
    expect([...extracted.children.find((child) => child.name === 'long café report.bin')!.bytes]).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('emits HTML-only mail as blocks through the shared HTML emitter', async () => {
    const html = readFileSync(new URL('../../../../../corpus/eml/html-only.eml', import.meta.url));
    const { document } = await readEmail(html);
    expect(JSON.stringify(document.blocks)).toContain('HTML ONLY MARKER');
    expect(JSON.stringify(document.blocks)).toContain('HTML body sentence.');
    expect(JSON.stringify(document.blocks)).not.toContain('This fallback plain part should not exist.');
  });

  it('caps text decoding at the remaining output allowance plus one character', async () => {
    const { document } = await readEmail(
      `Content-Type: text/plain; charset=utf-8\r\n\r\n${'x'.repeat(1_000_000)}`,
      true,
      { outputChars: 8 },
    );
    expect(document.blocks).toMatchObject([{ kind: 'paragraph', text: 'xxxxxxxx' }]);
    expect(document.stats.truncated).toBe(true);
    expect(document.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
  });

  it('budgets HTML by visible output, not markup length', async () => {
    const input = 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>1234567890</p>';
    const result = await readEmail(input, true, { outputChars: 10 });
    expect(result.document.blocks).toMatchObject([{ kind: 'paragraph', text: '1234567890' }]);
    expect(result.document.stats.truncated).toBe(false);
    await expect(readEmail(input, true, { outputChars: 10 }, 'keep', 'throw')).resolves.toMatchObject({
      document: { stats: { truncated: false } },
    });
  });

  it('keeps quoted history by default and drops common reply separators when explicitly requested', async () => {
    const gmail =
      'Content-Type: text/plain; charset=utf-8\r\n\r\nNewest note.\r\n\r\nOn Tue, Alice wrote:\r\n> old note\r\n';
    const kept = await readEmail(gmail);
    const dropped = await readEmail(gmail, true, {}, 'drop');
    expect(JSON.stringify(kept.document.blocks)).toContain('On Tue, Alice wrote:');
    expect(JSON.stringify(dropped.document.blocks)).toContain('Newest note.');
    expect(JSON.stringify(dropped.document.blocks)).not.toContain('On Tue, Alice wrote:');

    for (const separator of [
      'From: Alice <alice@example.test>\nSent: Tuesday\nTo: Bob\nSubject: Old message',
      'On 9 Oct 2026, Alice wrote:\n> old message',
    ]) {
      const value = await readEmail(
        `Content-Type: text/plain\r\n\r\nFresh content\n\n${separator}\n`,
        true,
        {},
        'drop',
      );
      expect(JSON.stringify(value.document.blocks)).not.toContain(separator.slice(0, 14));
    }
  });

  it('preserves mixed body order and lists image attachments while redacting inline addresses', async () => {
    const mixed = readFileSync(
      new URL('../../../../../corpus/eml/mixed-order-attachments.eml', import.meta.url),
    );
    const mixedResult = await readEmail(mixed);
    const mixedText = JSON.stringify(mixedResult.document.blocks);
    expect(mixedText.indexOf('MIXED BODY PART ONE')).toBeLessThan(mixedText.indexOf('MIXED BODY PART TWO'));
    expect(mixedResult.children.map((child) => child.name)).toEqual(['bundle.zip', 'note.docx']);

    const inline = readFileSync(new URL('../../../../../corpus/eml/inline-cid-privacy.eml', import.meta.url));
    const inlineResult = await readEmail(inline, false);
    expect(JSON.stringify(inlineResult.document)).not.toContain('private.sender@example.test');
    expect(JSON.stringify(inlineResult.document)).not.toContain('private.reader@example.test');
    expect(JSON.stringify(inlineResult.document)).not.toContain('private.cc@example.test');
    expect(inlineResult.children.map((child) => child.name)).toContain('tiny.png');
    expect(inlineResult.document.blocks.filter((block) => block.kind === 'image')).toMatchObject([
      { kind: 'image', ref: 'tiny.png' },
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { markdownReader } from '../../../src/readers/markdown/index.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { AbortError } from '../../../src/core/errors.js';
import { txtReader as reader } from '../../../src/readers/txt/index.js';

// Timing assertions mean nothing under coverage instrumentation (`npm run coverage` sets this).
const underCoverage =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.DOCSLUICE_COVERAGE === '1';

async function parse(
  source: Uint8Array | string,
  limits: Record<string, number> = {},
  signal?: AbortSignal,
  path = '',
) {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings, signal });
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder('txt', 'text/plain', budget);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path,
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

describe('TXT reader', () => {
  it('reads four licensed TXT/Markdown corpus files with reviewed content and encoding facts', async () => {
    for (const fixture of [
      {
        file: 'txt/paragraphs.txt',
        reader,
        encoding: 'utf-8',
        text: ['First paragraph keeps an internal', 'Second paragraph has café'],
      },
      { file: 'txt/utf16le-bom.txt', reader, encoding: 'utf-16le', text: ['Title', 'Second paragraph 🌙'] },
      {
        file: 'txt/windows-1252.txt',
        reader,
        encoding: 'windows-1252',
        text: ['Café notes.', 'Crème brûlée.'],
      },
      {
        file: 'markdown/constructs.md',
        reader: markdownReader,
        encoding: 'utf-8',
        text: ['Main heading', 'nested beta', 'const x = 1;', 'row 1'],
      },
    ]) {
      const bytes = new Uint8Array(
        readFileSync(new URL('../../../../../corpus/' + fixture.file, import.meta.url)),
      );
      const budget = new Budget(resolveLimits());
      const out = new DocBuilder(fixture.reader.id, fixture.reader.mimeTypes[0]!, budget);
      await fixture.reader.read({
        bytes,
        options: { limits: budget.limits, runs: false } as ResolvedOptions,
        budget,
        warnings: budget.warnings,
        out,
        path: '',
        extractChild: async () => {},
      });
      const doc = out.finish();
      expect(doc.encoding, fixture.file).toBe(fixture.encoding);
      for (const text of fixture.text) expect(JSON.stringify(doc.blocks), fixture.file).toContain(text);
    }
  });
  it('splits paragraphs on blank lines and keeps internal line breaks', async () => {
    const { doc } = await parse('First line\nsecond line\r\n\r\nThird');
    expect(doc.encoding).toBe('utf-8');
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', text: 'First line\nsecond line', loc: {} },
      { kind: 'paragraph', text: 'Third', loc: {} },
    ]);
  });

  it('reports UTF-16 encoding and stops at output budget without exposing content in warnings', async () => {
    const bytes = new Uint8Array(62);
    bytes.set([0xff, 0xfe]);
    for (let index = 0; index < 30; index++) bytes.set([0x61, 0], 2 + index * 2);
    const { doc, warnings } = await parse(bytes, { outputChars: 5 });
    expect(doc.encoding).toBe('utf-16le');
    expect(doc.blocks.map((block) => (block.kind === 'paragraph' ? block.text : ''))).toEqual(['aaaaa']);
    expect(warnings.map((warning) => warning.code)).toContain('TRUNCATED');
    expect(JSON.stringify(warnings)).not.toContain('aaaaa');
  });

  it.skipIf(underCoverage)(
    'bounds a 50 MB paragraph and returns within the two-second acceptance limit',
    async () => {
      const bytes = new TextEncoder().encode('x'.repeat(50_000_000));
      const started = performance.now();
      const { doc } = await parse(bytes, { outputChars: 1_000_000 });
      const elapsed = performance.now() - started;
      expect(doc.blocks).toMatchObject([{ kind: 'paragraph', text: 'x'.repeat(1_000_000) }]);
      expect(doc.stats.truncated).toBe(true);
      expect(elapsed).toBeLessThan(2_000);
    },
  );

  it('honors cancellation before decoding source bytes', async () => {
    const controller = new AbortController();
    controller.abort('cancel TXT read');
    await expect(parse('source', {}, controller.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('carries the child document path on every emitted paragraph', async () => {
    const { doc } = await parse('child text', {}, undefined, 'archive/note.txt');
    expect(doc.blocks[0]).toMatchObject({ kind: 'paragraph', loc: { path: 'archive/note.txt' } });
  });
});

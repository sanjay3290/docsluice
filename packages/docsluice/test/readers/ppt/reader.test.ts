import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import {
  AbortError,
  CorruptFileError,
  EncryptedError,
  LimitExceededError,
} from '../../../src/core/errors.js';
import { resolveLimits } from '../../../src/core/limits.js';
import type { Limits } from '../../../src/core/limits.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { openCfb } from '../../../src/ole/index.js';
import { pptReader } from '../../../src/readers/ppt/index.js';

const fixture = () =>
  new Uint8Array(readFileSync(new URL('../../../../../corpus/ppt/order-title-notes.ppt', import.meta.url)));

function context(
  bytes = fixture(),
  limits: Partial<Limits> = {},
  options: Partial<ResolvedOptions> = {},
): ReadContext {
  const resolved: ResolvedOptions = {
    limits: resolveLimits(limits),
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    children: 'extract',
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
    ...options,
  };
  const budget = new Budget(resolved.limits, { onLimit: resolved.onLimit, signal: resolved.signal });
  budget.addInputBytes(bytes.byteLength);
  return {
    bytes,
    options: resolved,
    budget,
    warnings: budget.warnings,
    out: new DocBuilder('ppt', 'application/vnd.ms-powerpoint', budget, resolved),
    path: '',
    extractChild: async () => {},
  };
}

describe('legacy PPT reader', () => {
  it('matches the reviewed direct-reader JSON golden', async () => {
    const expected: unknown = JSON.parse(
      readFileSync(
        new URL('../../../../../corpus/ppt/order-title-notes.ppt.expected.json', import.meta.url),
        'utf8',
      ),
    );
    const ctx = context();
    await pptReader.read(ctx);
    expect(ctx.out.finish()).toEqual(expected);
  });

  it('reads a LibreOffice deck in slide order with a title and separate notes', async () => {
    const ctx = context();
    await pptReader.read(ctx);
    const doc = ctx.out.finish();
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks.map((b) => b.loc.slide)).toEqual([1, 2, 3]);
    const sections = doc.blocks.filter((b) => b.kind === 'section');
    expect(sections[0]).toMatchObject({ role: 'slide', title: 'TEN FIRST' });
    expect(sections[0]?.blocks[0]).toMatchObject({ kind: 'heading', text: 'TEN FIRST' });
    for (const [index, section] of sections.entries()) {
      const body = section.blocks
        .filter((b) => b.kind === 'paragraph')
        .map((b) => b.text)
        .join('\n');
      expect(body).toContain(
        ['Slide one body: Alpha', 'Slide two body: café Ω 中', 'Slide three body: Omega'][index],
      );
      expect(section.blocks.filter((b) => b.kind === 'note')).toEqual([
        {
          kind: 'note',
          role: 'speaker-notes',
          text: ['Speaker note one: note ten', 'Speaker note two: note two', 'Speaker note three: note one'][
            index
          ],
          loc: { slide: index + 1 },
        },
      ]);
    }
    expect(doc.warnings).toEqual([]);
  });

  it('preserves parent-child paths on every emitted location', async () => {
    const base = context();
    const ctx = { ...base, path: 'archive/deck.ppt' };
    await pptReader.read(ctx);
    for (const section of ctx.out.finish().blocks) {
      expect(section.loc.path).toBe('archive/deck.ppt');
      if (section.kind === 'section')
        for (const block of section.blocks) expect(block.loc.path).toBe('archive/deck.ppt');
    }
  });

  it('reuses the CFB index supplied by detection', async () => {
    const ctx = context();
    const cfb = openCfb(ctx.bytes, ctx.budget);
    await pptReader.read({ ...ctx, bytes: new Uint8Array(), cfb });
    expect(ctx.out.finish().blocks).toHaveLength(3);
  });

  it('rejects input with no readable presentation streams', async () => {
    await expect(pptReader.read(context(new Uint8Array()))).rejects.toBeInstanceOf(CorruptFileError);
  });

  it.each(['invalid-edit-pointer', 'oversized-persist-run'])(
    'rejects the %s hostile PPT fixture',
    async (name) => {
      const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/hostile/${name}.ppt`, import.meta.url)));
      await expect(pptReader.read(context(bytes))).rejects.toBeInstanceOf(CorruptFileError);
    },
  );

  it('rejects the encrypted-token hostile PPT fixture', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/hostile/encrypted-user-token.ppt', import.meta.url)),
    );
    await expect(pptReader.read(context(bytes))).rejects.toBeInstanceOf(EncryptedError);
  });

  it('propagates caller cancellation before reading input', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      pptReader.read(context(fixture(), {}, { signal: controller.signal })),
    ).rejects.toBeInstanceOf(AbortError);
  });

  it('returns a truncated document under a small output allowance', async () => {
    const ctx = context(fixture(), { outputChars: 20 });
    await pptReader.read(ctx);
    const doc = ctx.out.finish();
    expect(doc.stats.truncated).toBe(true);
    expect(doc.warnings.some((w) => w.code === 'TRUNCATED')).toBe(true);
    expect(ctx.budget.outputChars).toBeLessThanOrEqual(20);
  });

  it('propagates output-limit errors when configured to throw', async () => {
    const ctx = context(fixture(), { outputChars: 20 }, { onLimit: 'throw' });
    await expect(pptReader.read(ctx)).rejects.toBeInstanceOf(LimitExceededError);
  });
});

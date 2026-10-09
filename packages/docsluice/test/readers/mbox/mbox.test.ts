import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { reader } from '../../../src/readers/mbox/index.js';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';

const resolved: ResolvedOptions = {
  limits: DEFAULT_LIMITS,
  onLimit: 'truncate',
  strict: false,
  metadata: true,
  children: 'list',
  childBytes: false,
  runs: false,
  revisions: 'accept',
  includeHidden: false,
  formulas: false,
};

describe('MBOX reader', () => {
  it('splits messages and removes exactly one mboxrd escape marker', async () => {
    const bytes = new TextEncoder().encode(
      'From one@example.test Tue Oct  6 09:30:00 2026\nSubject: One\n\nMBOX MESSAGE ONE\n>From one escaped separator\n\nFrom two@example.test Tue Oct  6 09:31:00 2026\nSubject: Two\n\nMBOX MESSAGE TWO\n>>From two escaped separators\n',
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const out = new DocBuilder('mbox', 'application/mbox', budget, resolved);
    const children: Array<{ name: string; body: string }> = [];
    const ctx: ReadContext = {
      bytes,
      options: resolved,
      budget,
      warnings: new WarningSink(),
      out,
      path: '',
      extractChild: (name, childBytes) =>
        Promise.resolve().then(() => {
          children.push({ name, body: new TextDecoder().decode(childBytes) });
        }),
    };
    await reader.read(ctx);
    const result = out.finish();
    expect(children).toHaveLength(2);
    expect(children[0]?.body).toContain('From one escaped separator');
    expect(children[1]?.body).toContain('>From two escaped separators');
    expect(children[0]?.body).not.toContain('From one@example.test');
    expect(result.children).toHaveLength(0);
  });

  it('passes each reviewed mboxrd message to the shared child extractor in order', async () => {
    const bytes = readFileSync(
      new URL('../../../../../corpus/mbox/mboxrd-two-messages.mbox', import.meta.url),
    );
    const budget = new Budget(DEFAULT_LIMITS);
    const out = new DocBuilder('mbox', 'application/mbox', budget, resolved);
    const children: Array<{ name: string; body: string; mimeType?: string }> = [];
    const ctx: ReadContext = {
      bytes,
      options: resolved,
      budget,
      warnings: new WarningSink(),
      out,
      path: '',
      extractChild: (name, childBytes, hint) =>
        Promise.resolve().then(() => {
          children.push({ name, body: new TextDecoder().decode(childBytes), mimeType: hint?.mimeType });
        }),
    };
    await reader.read(ctx);
    expect(children.map((child) => child.name)).toEqual(['message-1.eml', 'message-2.eml']);
    expect(children.map((child) => child.mimeType)).toEqual(['message/rfc822', 'message/rfc822']);
    expect(children[0]?.body).toContain(
      'MBOX MESSAGE ONE\nFrom one escaped separator\n>From two escaped separators',
    );
    expect(children[1]?.body).toContain('MBOX MESSAGE TWO\nFromage ordinary body line');
    expect(children[0]?.body).not.toContain('From sender@example.test');
  });

  it('stops cleanly when the shared message-entry allowance is exhausted', async () => {
    const bytes = new TextEncoder().encode(
      'From one@example.test Tue Oct  6 09:30:00 2026\nSubject: One\n\nFirst\nFrom two@example.test Tue Oct  6 09:31:00 2026\nSubject: Two\n\nSecond\n',
    );
    const budget = new Budget({ ...DEFAULT_LIMITS, zipEntries: 1 });
    const out = new DocBuilder('mbox', 'application/mbox', budget, resolved);
    const children: string[] = [];
    await reader.read({
      bytes,
      options: resolved,
      budget,
      warnings: new WarningSink(),
      out,
      path: '',
      extractChild: (_name, childBytes) =>
        Promise.resolve().then(() => {
          children.push(new TextDecoder().decode(childBytes));
        }),
    });
    expect(children).toHaveLength(1);
    expect(children[0]).toContain('First');
    expect(children[0]).not.toContain('From two@example.test');
    expect(budget.warnings.warnings.map((warning) => warning.code)).toContain('TRUNCATED');
  });
});

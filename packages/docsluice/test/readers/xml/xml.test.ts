import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import { xmlReader as reader } from '../../../src/readers/xml/index.js';

async function parse(source: string, limits: Record<string, number> = {}) {
  const bytes = new TextEncoder().encode(source);
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(limits), { warnings });
  const options = { limits: budget.limits, runs: false } as ResolvedOptions;
  const out = new DocBuilder('xml', 'application/xml', budget, options);
  const ctx = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings };
}

describe('XML reader', () => {
  it('prefixes element locations with the pipeline child path exactly once', async () => {
    const budget = new Budget(resolveLimits());
    const out = new DocBuilder('xml', 'application/xml', budget);
    await reader.read({
      bytes: new TextEncoder().encode('<root><item>child</item></root>'),
      options: { limits: budget.limits } as ResolvedOptions,
      budget,
      warnings: budget.warnings,
      out,
      path: 'archive/data.xml',
      extractChild: async () => {},
    });
    expect(out.finish().blocks).toMatchObject([{ loc: { path: 'archive/data.xml/root/item' } }]);
  });
  it('emits direct element text with stable sibling-indexed paths and skips attributes', async () => {
    const { doc } = await parse(
      '<root><child code="A"><name>Amber</name></child><child code="B"><name>Blue</name></child><note>line one &amp; line two</note></root>',
    );
    expect(doc.blocks).toEqual([
      { kind: 'paragraph', text: 'Amber', loc: { path: '/root/child[1]/name' } },
      { kind: 'paragraph', text: 'Blue', loc: { path: '/root/child[2]/name' } },
      { kind: 'paragraph', text: 'line one & line two', loc: { path: '/root/note' } },
    ]);
    expect(JSON.stringify(doc.blocks)).not.toContain('code="A"');
  });

  it('ignores external and internal DTD entities without expanding or fetching them', async () => {
    const before = Object.getOwnPropertyNames(Object.prototype).sort();
    const { doc, warnings } = await parse(
      '<!DOCTYPE root [<!ENTITY secret SYSTEM "file:///docsluice-fixture-secret"><!ENTITY a "ha"><!ENTITY b "&a;&a;&a;&a;">]><root>&secret; &b;</root>',
    );
    expect(JSON.stringify(doc)).not.toContain('docsluice-fixture-secret');
    expect(JSON.stringify(doc)).not.toContain('hahahaha');
    expect(warnings.map(({ code }) => code)).toContain('DTD_IGNORED');
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(before);
  });

  it('respects caller cancellation while scanning XML', async () => {
    const controller = new AbortController();
    controller.abort('stop');
    const bytes = new TextEncoder().encode('<root>secret</root>');
    const warnings = new WarningSink();
    const budget = new Budget(resolveLimits(), { warnings, signal: controller.signal });
    const options = { limits: budget.limits, runs: false } as ResolvedOptions;
    const out = new DocBuilder('xml', 'application/xml', budget, options);
    const ctx = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: async () => {},
    } as ReadContext;
    await expect(reader.read(ctx)).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('checks staged XML text and emitted blocks against the output budget', async () => {
    const { doc, warnings } = await parse('<root>abcdefghij</root>', { outputChars: 5 });
    expect(doc.stats.truncated).toBe(true);
    expect(doc.blocks).toEqual([]);
    expect(warnings.map(({ code }) => code)).toContain('TRUNCATED');
  });
});

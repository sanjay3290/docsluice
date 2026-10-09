import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { resolveLimits } from '../../../src/core/limits.js';
import { WarningSink } from '../../../src/core/warnings.js';
import type { ReadContext, Reader } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';

export async function parse(
  reader: Reader,
  source: string | Uint8Array,
  options: {
    runs?: boolean;
    metadata?: boolean;
    limits?: Record<string, number>;
    filename?: string;
    onLimit?: 'truncate' | 'throw';
    signal?: AbortSignal;
    captureContext?: (ctx: ReadContext) => void;
  } = {},
) {
  const bytes = typeof source === 'string' ? new TextEncoder().encode(source) : source;
  const warnings = new WarningSink();
  const budget = new Budget(resolveLimits(options.limits), {
    warnings,
    onLimit: options.onLimit,
    signal: options.signal,
  });
  const resolved = {
    limits: budget.limits,
    runs: options.runs ?? false,
    metadata: options.metadata ?? true,
  } as ResolvedOptions;
  const out = new DocBuilder(reader.id, reader.mimeTypes[0] ?? 'text/plain', budget, resolved);
  const ctx = {
    bytes,
    filename: options.filename,
    options: resolved,
    budget,
    warnings,
    out,
    path: '',
    extractChild: async () => {},
  } as ReadContext;
  options.captureContext?.(ctx);
  await reader.read(ctx);
  return { doc: out.finish(), warnings: warnings.warnings, budget };
}

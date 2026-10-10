import { DocsluiceError } from '../src/core/errors.js';
import { Budget } from '../src/core/budget.js';
import { DocBuilder } from '../src/core/builder.js';
import { DEFAULT_LIMITS } from '../src/core/limits.js';
import type { ReadContext, Reader } from '../src/core/reader.js';
import type { ResolvedOptions } from '../src/core/options.js';
import { WarningSink } from '../src/core/warnings.js';
import { icsReader } from '../src/readers/ics/index.js';
import { ndjsonReader } from '../src/readers/ndjson/index.js';
import { srtReader } from '../src/readers/srt/index.js';
import { vcfReader } from '../src/readers/vcf/index.js';
import { vttReader } from '../src/readers/vtt/index.js';
import { yamlReader } from '../src/readers/yaml/index.js';

const READERS: readonly Reader[] = [yamlReader, ndjsonReader, icsReader, vcfReader, srtReader, vttReader];

/** Run the YAML, NDJSON, iCalendar, vCard, SubRip and WebVTT readers on the same input, each bounded. */
export async function fuzzTextFamilies(input: Uint8Array): Promise<void> {
  const bytes = input.subarray(0, 256 * 1024);
  for (const reader of READERS) {
    const warnings = new WarningSink();
    const budget = new Budget(
      { ...DEFAULT_LIMITS, outputChars: 262_144, blockDepth: 32, timeMs: 1_000 },
      { warnings },
    );
    const options: ResolvedOptions = {
      limits: budget.limits,
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
    const out = new DocBuilder(reader.id, reader.mimeTypes[0] ?? 'text/plain', budget, options);
    const context: ReadContext = {
      bytes,
      options,
      budget,
      warnings,
      out,
      path: '',
      extractChild: () => Promise.resolve(),
    };
    try {
      await reader.read(context);
      out.finish();
    } catch (error) {
      // Limits are ordinary outcomes; anything else is a finding.
      if (error instanceof DocsluiceError) continue;
      throw error;
    }
  }
}

import type { Budget } from './budget.js';
import type { DocBuilder } from './builder.js';
import type { FormatId } from './model.js';
import type { ResolvedOptions } from './options.js';
import type { WarningSink } from './warnings.js';
import type { ZipArchive } from '../zip/index.js';
import type { CfbArchive } from '../ole/index.js';

/** A format reader loaded only when that format is requested. */
export interface Reader {
  readonly id: FormatId;
  readonly mimeTypes: readonly string[];
  /** Optional bounded probe; return a confidence from zero to one. */
  detect?(bytes: Uint8Array): number;
  read(ctx: ReadContext): Promise<void>;
}

/** One document's reader context. Resource allowances are shared with its children. */
export interface ReadContext {
  readonly bytes: Uint8Array;
  readonly filename?: string;
  readonly options: ResolvedOptions;
  readonly budget: Budget;
  readonly warnings: WarningSink;
  readonly out: DocBuilder;
  /** Full parent-child prefix; an empty string identifies the root document. */
  readonly path: string;
  extractChild(name: string, bytes: Uint8Array, hint?: { mimeType?: string }): Promise<void>;
  /** Reuse the archive index opened by format detection. */
  readonly zip?: ZipArchive;
  /** Reuse the compound-file index opened by legacy-format detection. */
  readonly cfb?: CfbArchive;
}

import type { Block, FormatId, WarningCode } from './model.js';
import type { Limits } from './limits.js';
import type { ReaderRegistry } from './registry.js';

/**
 * Options for `extract()` (PRD sections 7-17). Every option has a safe default; none is required.
 * Option names are the same across formats. A reader ignores options it does not use, with no warning.
 */
export interface ExtractOptions {
  /** Isolated per-call reader registry. Defaults to the shared built-in registry. */
  registry?: ReaderRegistry;

  /** File name hint (IN-3). Never trusted over content (IN-8). */
  filename?: string;
  /** MIME type hint (IN-3). Never trusted over content (IN-8). */
  mimeType?: string;
  /** Force a reader and skip sniffing (IN-3). */
  format?: FormatId;

  /** Per-call limit overrides (section 14.2). */
  limits?: Partial<Limits>;
  /** What to do when a limit is hit. Default 'truncate'. inputBytes and compressionRatio always throw. */
  onLimit?: 'truncate' | 'throw';
  /** Turn chosen warning codes into errors. `true` means every warning code. */
  strict?: boolean | WarningCode[];
  /** Caller cancellation (EXT-1). */
  signal?: AbortSignal;

  /** `false` drops all personal metadata in one switch (MOD-4, section 15). Default true. */
  metadata?: boolean;
  /** Child documents: 'extract' (default), 'list' or 'skip' (NST-4). */
  children?: 'extract' | 'list' | 'skip';
  /** Keep raw bytes of child documents (NST-5). Default false. */
  childBytes?: boolean;
  /** Keep inline formatting runs on paragraphs (MOD-3). Default false. */
  runs?: boolean;

  /** Tracked changes in Word files (DOC-6). Default 'accept'. */
  revisions?: 'accept' | 'reject' | 'show';
  /** Include hidden text (DOC-9). Default false. */
  includeHidden?: boolean;
  /** Return formula text on spreadsheet cells (XLS-4). Default false. */
  formulas?: boolean;
  /** Password for encrypted files (PDF-5). */
  password?: string;

  /** Runs on every block before any renderer (EXT-3). Return null to drop the block. */
  transform?: (block: Block) => Block | null;
  /** Called for each top-level block as it is produced (EXT-2). */
  onBlock?: (block: Block) => void;
}

/** Effective options shared by the root reader and every nested reader. */
export interface ResolvedOptions extends Omit<ExtractOptions, 'limits' | 'strict'> {
  readonly limits: Readonly<Limits>;
  readonly onLimit: 'truncate' | 'throw';
  readonly strict: boolean | readonly WarningCode[];
  readonly metadata: boolean;
  readonly children: 'extract' | 'list' | 'skip';
  readonly childBytes: boolean;
  readonly runs: boolean;
  readonly revisions: 'accept' | 'reject' | 'show';
  readonly includeHidden: boolean;
  readonly formulas: boolean;
}

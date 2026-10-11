/**
 * Default limits (PRD section 14.2). Starting points: tune with benchmarks before 1.0.
 * Every limit can be changed per call through `ExtractOptions.limits`.
 */

export interface Limits {
  /** Maximum input size in bytes. Always throws. */
  inputBytes: number;
  /** Total uncompressed bytes across all zip entries and all children (SEC-1, NST-1). */
  totalUncompressedBytes: number;
  /** Maximum compression ratio per entry. Always throws. */
  compressionRatio: number;
  /** The ratio limit applies only when an entry is larger than this many uncompressed bytes. */
  compressionRatioMinBytes: number;
  /** Maximum archive entries / physical CFB directory slots per extraction (SEC-2, SEC-8). */
  zipEntries: number;
  /** Maximum nesting depth of child documents (NST-2). */
  childDepth: number;
  /** Maximum XML element depth (SEC-5, SEC-8). */
  xmlDepth: number;
  /** Maximum nesting depth of blocks, lists and tables built from file data (SEC-8). */
  blockDepth: number;
  /** Maximum output characters (SEC-12). */
  outputChars: number;
  /** Maximum spreadsheet cells across the whole workbook (SEC-12, XLS-6). */
  cells: number;
  /** Maximum PDF pages. */
  pdfPages: number;
  /** Maximum fonts the PDF engine loads across all PDFs; text in a refused font is lost (SEC-12). */
  pdfFonts: number;
  /** Time budget in milliseconds (SEC-9). */
  timeMs: number;
}

const MB = 1_000_000;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  inputBytes: 100 * MB,
  totalUncompressedBytes: 500 * MB,
  compressionRatio: 100,
  compressionRatioMinBytes: 1 * MB,
  zipEntries: 10_000,
  childDepth: 3,
  xmlDepth: 256,
  blockDepth: 64,
  outputChars: 20_000_000,
  cells: 2_000_000,
  pdfPages: 2_000,
  pdfFonts: 256,
  timeMs: 60_000,
});

/** Limits that always throw, whatever `onLimit` says: a partial bomb is still a bomb. */
export const ALWAYS_THROW_LIMITS: ReadonlySet<keyof Limits> = new Set<keyof Limits>([
  'inputBytes',
  'compressionRatio',
]);

function getLimit(overrides: Partial<Limits>, key: keyof Limits): number | undefined {
  switch (key) {
    case 'inputBytes':
      return overrides.inputBytes;
    case 'totalUncompressedBytes':
      return overrides.totalUncompressedBytes;
    case 'compressionRatio':
      return overrides.compressionRatio;
    case 'compressionRatioMinBytes':
      return overrides.compressionRatioMinBytes;
    case 'zipEntries':
      return overrides.zipEntries;
    case 'childDepth':
      return overrides.childDepth;
    case 'xmlDepth':
      return overrides.xmlDepth;
    case 'blockDepth':
      return overrides.blockDepth;
    case 'outputChars':
      return overrides.outputChars;
    case 'cells':
      return overrides.cells;
    case 'pdfPages':
      return overrides.pdfPages;
    case 'pdfFonts':
      return overrides.pdfFonts;
    case 'timeMs':
      return overrides.timeMs;
  }
}

function setLimit(limits: Limits, key: keyof Limits, value: number): void {
  switch (key) {
    case 'inputBytes':
      limits.inputBytes = value;
      break;
    case 'totalUncompressedBytes':
      limits.totalUncompressedBytes = value;
      break;
    case 'compressionRatio':
      limits.compressionRatio = value;
      break;
    case 'compressionRatioMinBytes':
      limits.compressionRatioMinBytes = value;
      break;
    case 'zipEntries':
      limits.zipEntries = value;
      break;
    case 'childDepth':
      limits.childDepth = value;
      break;
    case 'xmlDepth':
      limits.xmlDepth = value;
      break;
    case 'blockDepth':
      limits.blockDepth = value;
      break;
    case 'outputChars':
      limits.outputChars = value;
      break;
    case 'cells':
      limits.cells = value;
      break;
    case 'pdfPages':
      limits.pdfPages = value;
      break;
    case 'pdfFonts':
      limits.pdfFonts = value;
      break;
    case 'timeMs':
      limits.timeMs = value;
      break;
  }
}

/** Merge caller limits over the defaults. Unknown keys are ignored. */
export function resolveLimits(overrides?: Partial<Limits>): Limits {
  const resolved: Limits = { ...DEFAULT_LIMITS };
  if (!overrides) return resolved;
  for (const key of Object.keys(DEFAULT_LIMITS) as Array<keyof Limits>) {
    const value = getLimit(overrides, key);
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`Limit "${key}" must be a finite number >= 0.`);
    }
    setLimit(resolved, key, value);
  }
  return resolved;
}

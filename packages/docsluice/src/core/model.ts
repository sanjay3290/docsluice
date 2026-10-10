/**
 * The docsluice output model. This file is the public contract (PRD section 9, MOD-1).
 * A breaking change here is a major version. Change it only through an issue that says so.
 *
 * Rule for every type in this file: no field holds a plain object keyed by file data.
 * Key/value data from files is an array of pairs (SEC-6).
 */

/** Format ids that docsluice knows. A plugin may add its own string id. */
export type FormatId =
  | 'txt'
  | 'markdown'
  | 'csv'
  | 'tsv'
  | 'json'
  | 'xml'
  | 'html'
  | 'yaml'
  | 'ndjson'
  | 'ics'
  | 'vcf'
  | 'srt'
  | 'vtt'
  | 'rtf'
  | 'docx'
  | 'docm'
  | 'xlsx'
  | 'xlsm'
  | 'xlsb'
  | 'pptx'
  | 'pptm'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'doc'
  | 'xls'
  | 'ppt'
  | 'pdf'
  | 'epub'
  | 'eml'
  | 'mbox'
  | 'msg'
  | 'zip'
  | 'gzip'
  | 'tar'
  | 'ole'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'tiff'
  | 'webp'
  | 'audio'
  | 'video'
  | 'unknown'
  | (string & {});

export interface DocsluiceDocument {
  format: FormatId;
  mimeType: string;
  /** Text encoding used for text formats (IN-7). Absent for binary formats. */
  encoding?: string;
  metadata: Metadata;
  /** Content found in the file but never run or fetched (MOD-5). */
  features: Features;
  blocks: Block[];
  /** Attachments, embedded files, archive entries (section 11). */
  children: ChildDocument[];
  warnings: Warning[];
  stats: Stats;
}

export interface Stats {
  bytesRead: number;
  durationMs: number;
  truncated: boolean;
  needsOcr: boolean;
}

export interface Metadata {
  title?: string;
  authors?: string[];
  /** ISO 8601 string. */
  created?: string;
  /** ISO 8601 string. */
  modified?: string;
  pageCount?: number;
  language?: string;
  /** Custom properties as name/value pairs, never as an object keyed by file data. */
  custom?: Array<{ name: string; value: string }>;
}

export interface Features {
  hasMacros: boolean;
  hasExternalLinks: boolean;
  hasEmbeddedFiles: boolean;
  isEncrypted: boolean;
  hasJavaScript: boolean;
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | ListBlock
  | TableBlock
  | CodeBlock
  | ImageBlock
  | NoteBlock
  | HeaderFooterBlock
  | SectionBlock;

export type BlockKind = Block['kind'];

export interface HeadingBlock {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  loc: Location;
}

export interface ParagraphBlock {
  kind: 'paragraph';
  text: string;
  /** Inline formatting. Only present when the `runs` option is on (MOD-3). */
  runs?: Run[];
  loc: Location;
}

export interface ListBlock {
  kind: 'list';
  ordered: boolean;
  items: ListItem[];
  loc: Location;
}

export interface ListItem {
  text: string;
  /** The marker a person sees, for example "1.", "a)", "•". */
  marker?: string;
  /** Nested list items. */
  items?: ListItem[];
}

export interface TableBlock {
  kind: 'table';
  rows: Cell[][];
  /** Number of leading rows that form the header. 0 when none. */
  headerRows: number;
  caption?: string;
  loc: Location;
}

export interface Cell {
  /** The value a person sees (number formats applied, XLS-3). */
  text: string;
  /** The stored value, when it differs from `text`. */
  raw?: string | number | boolean | null;
  /** Formula text, only when the `formulas` option is on (XLS-4). Never evaluated. */
  formula?: string;
  rowSpan?: number;
  colSpan?: number;
  /** Cell address for spreadsheets, for example "B7" (XLS-7). */
  address?: string;
  hidden?: boolean;
}

export interface CodeBlock {
  kind: 'code';
  language?: string;
  text: string;
  loc: Location;
}

export interface ImageBlock {
  kind: 'image';
  alt?: string;
  mimeType?: string;
  /** Reference to a child document that holds the image bytes (ADR 0005). */
  ref?: string;
  width?: number;
  height?: number;
  loc: Location;
}

export interface NoteBlock {
  kind: 'note';
  role: 'footnote' | 'endnote' | 'comment' | 'speaker-notes' | 'annotation';
  text: string;
  author?: string;
  loc: Location;
}

export interface HeaderFooterBlock {
  kind: 'header' | 'footer';
  text: string;
  loc: Location;
}

export interface SectionBlock {
  kind: 'section';
  role: 'page' | 'slide' | 'sheet' | 'part';
  title?: string;
  /** Set for hidden sheets and hidden slides (XLS-1, PPT-5). */
  hidden?: boolean | 'very';
  /** Set for PDF pages with no text layer (PDF-4). */
  needsOcr?: boolean;
  blocks: Block[];
  loc: Location;
}

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export interface Location {
  /** PDF page number, 1-based. */
  page?: number;
  pageLabel?: string;
  /** Slide number, 1-based. */
  slide?: number;
  sheet?: string;
  /** Cell range, for example "B2:D9". */
  range?: string;
  /** XML path, zip entry, or child document path (NST-3). */
  path?: string;
  /** Character offsets into default `toText(document)` output. Rendering options can shift these spans. */
  offset?: [start: number, end: number];
}

export interface ChildDocument {
  /** Full path from the root, for example "report.zip/q3.docx/embedded.xlsx" (NST-3). */
  path: string;
  name: string;
  status: 'extracted' | 'listed' | 'skipped' | 'failed';
  sizeBytes?: number;
  mimeType?: string;
  /** Present when status is "extracted". */
  document?: DocsluiceDocument;
  /** Raw bytes, only when the `childBytes` option is on (NST-5). */
  bytes?: Uint8Array;
  /** Present when status is "failed". Never holds document content. */
  error?: { code: string; message: string };
}

export type WarningCode =
  | 'TRUNCATED'
  | 'FORMAT_MISMATCH'
  | 'NEEDS_OCR'
  | 'HIDDEN_CONTENT'
  | 'MACROS_PRESENT'
  | 'DEPTH_LIMIT'
  | 'UNREADABLE_PART'
  | 'ENCODING_GUESSED'
  | (string & {});

export interface Warning {
  code: WarningCode;
  /** Never holds document content (section 12). */
  message: string;
  loc?: Location;
}

export interface DetectResult {
  format: FormatId;
  mimeType: string;
  /** 0 to 1. */
  confidence: number;
  encoding?: string;
}

import { Budget } from '../core/budget.js';
import { EncryptedError, LimitExceededError } from '../core/errors.js';
import { readInput } from '../core/input.js';
import { resolvePlugin } from '../core/plugin.js';
import { resolveLimits } from '../core/limits.js';
import type { DetectResult, FormatId } from '../core/model.js';
import type { ExtractOptions } from '../core/options.js';
import { WarningSink } from '../core/warnings.js';
import type { CfbArchive } from '../ole/index.js';
import type { ZipArchive } from '../zip/index.js';
import { decodeText, detectEncoding } from './encoding.js';
import type { TextEncoding } from './encoding.js';
import { formatForFilename, isHashCommentSource, formatForMimeType, mimeTypeForFormat } from './mime.js';
import { sniffMagic } from './sniff.js';
import { detectTextKindCandidates } from './text-kind.js';

const TEXT_SAMPLE_BYTES = 8 * 1024;

export interface FormatResolution {
  readonly result: DetectResult;
  readonly zip?: ZipArchive;
  readonly cfb?: CfbArchive;
  /** The bytes to read instead of the input: the decrypted package of an encrypted OOXML file. */
  readonly bytes?: Uint8Array;
  /** The input was an encrypted OOXML package, opened with `password`. */
  readonly encrypted?: boolean;
}

type FormatHints = Pick<ExtractOptions, 'filename' | 'mimeType' | 'format' | 'password'>;

/**
 * Detect a format without parsing its document contents.
 *
 * Blob and stream inputs are normalized to bytes under the input-byte limit.
 * Format probes inspect only bounded prefixes plus ZIP/CFB structural indexes
 * and small ZIP markers.
 */
export async function detect(input: unknown, options: ExtractOptions = {}): Promise<DetectResult> {
  const warnings = new WarningSink({ strict: options.strict });
  const budget = new Budget(resolveLimits(options.limits), {
    onLimit: options.onLimit,
    signal: options.signal,
    warnings,
  });
  const bytes = await readInput(input, budget);
  const resolved = await resolveFormat(bytes, options, budget);
  if (!options.registry) return resolved.result;
  return resolvePlugin(options.registry, bytes, options, resolved, budget).result;
}

/** Resolve an already-read byte array; the caller's Budget already includes input bytes. */
export async function resolveFormat(
  bytes: Uint8Array,
  options: FormatHints,
  budget: Budget,
): Promise<FormatResolution> {
  budget.tick();

  if (options.format !== undefined) {
    return {
      result: {
        format: options.format,
        mimeType: mimeTypeForFormat(options.format),
        confidence: 1,
      },
    };
  }

  const magic = hasTextBom(bytes) ? { kind: null, mimeType: null, confidence: 0 } : sniffMagic(bytes);
  if (magic.kind === 'zip') {
    // Telling ZIP-based formats apart (OOXML, ODF, EPUB) serves non-text files only; it loads on demand.
    const { detectZipKind } = await import('./zip-kind.js');
    const archive = await detectZipKind(bytes, budget);
    const result = makeResult(archive.format, magic.confidence);
    warnIfMismatched(result.format, options, budget);
    return { result, zip: archive.zip };
  }

  if (magic.kind === 'ole') {
    // The compound-file parser serves legacy Office and Outlook files only; it loads on demand.
    const { openCfb } = await import('../ole/index.js');
    const archive = openCfb(bytes, budget);
    if (hasEncryptedPackage(archive.entries, budget)) {
      // [MS-OFFCRYPTO]: an OOXML package encrypted with a password; decryption loads on demand.
      if (options.password === undefined) throw new EncryptedError('password-required');
      const { decryptOffice } = await import('../office/encryption/index.js');
      const decrypted = await decryptOffice(archive, options.password, { budget, warnings: budget.warnings });
      if (decrypted === undefined) {
        // The shared allowance ran out before the package was decrypted: nothing partial exists.
        throw new LimitExceededError('totalUncompressedBytes', budget.limits.totalUncompressedBytes);
      }
      const inner = await resolveFormat(decrypted, { ...options, password: undefined }, budget);
      return { ...inner, bytes: decrypted, encrypted: true };
    }
    const format = classifyCfb(archive.entries, budget);
    const result =
      format === 'ole' ? makeResult(format, magic.confidence, magic.mimeType) : makeResult(format, 0.98);
    warnIfMismatched(result.format, options, budget);
    return { result, cfb: archive };
  }

  if (magic.kind !== null) {
    const result = makeResult(magic.kind, magic.confidence, magic.mimeType);
    warnIfMismatched(result.format, options, budget);
    return { result };
  }

  const encoding = detectEncoding(bytes);
  if (!encoding.isText || encoding.encoding === 'unsupported') {
    const result = { format: 'unknown', mimeType: mimeTypeForFormat('unknown'), confidence: 0 } as const;
    warnIfMismatched(result.format, options, budget);
    return { result };
  }

  if (encoding.warning) {
    budget.warnings.add({
      code: encoding.warning,
      message: 'The text encoding was inferred as Windows-1252 because the sample is not valid UTF-8.',
    });
  }
  const text = decodeText(getTextPrefix(bytes, encoding.encoding), encoding.encoding);
  const candidates = detectTextKindCandidates(text);
  let format = candidates[0] ?? 'txt';
  const filenameHint = formatForFilename(options.filename);
  const mimeHint = formatForMimeType(options.mimeType);
  let selectedByTie = false;
  let tiedFormats: ReadonlySet<FormatId> | undefined;
  if (
    candidates.length === 1 &&
    format === 'txt' &&
    (filenameHint === 'markdown' || mimeHint === 'markdown') &&
    (filenameHint === undefined || filenameHint === 'txt' || filenameHint === 'markdown') &&
    (mimeHint === undefined || mimeHint === 'txt' || mimeHint === 'markdown')
  ) {
    format = 'markdown';
    selectedByTie = true;
    tiedFormats = new Set(['txt', 'markdown']);
  } else if (
    candidates.every((candidate) => LOOSE_TEXT.has(candidate)) &&
    TEXT_FAMILY.has(filenameHint ?? mimeHint ?? '') &&
    (mimeHint ?? filenameHint) === (filenameHint ?? mimeHint)
  ) {
    // YAML has no reliable signature, and a damaged NDJSON, calendar, card or subtitle file can fail
    // its sniff: loose text (plain, Markdown- or CSV-like) named or typed as one of them, with no
    // disagreeing hint, is read as that format.
    format = (filenameHint ?? mimeHint)!;
    tiedFormats = new Set([...candidates, format]);
    selectedByTie = true;
  } else if (
    candidates.length === 1 &&
    format === 'markdown' &&
    isHashCommentSource(options.filename) &&
    filenameHint === undefined &&
    mimeHint === undefined
  ) {
    // Source code comments (`# …`) look like Markdown headings; a source file name keeps it text.
    format = 'txt';
    selectedByTie = true;
  } else if (
    candidates.length > 1 &&
    candidates.every((candidate) => candidate === 'csv' || candidate === 'tsv') &&
    (filenameHint === undefined || candidates.includes(filenameHint)) &&
    (mimeHint === undefined || candidates.includes(mimeHint))
  ) {
    const hints = new Set([filenameHint, mimeHint].filter((hint): hint is FormatId => hint !== undefined));
    if (hints.size === 1) {
      format = hints.values().next().value ?? format;
      selectedByTie = true;
      tiedFormats = new Set(candidates);
    }
  }

  const result: DetectResult = {
    format,
    mimeType: mimeTypeForFormat(format),
    confidence: format === 'txt' ? 0.65 : selectedByTie ? 0.55 : 0.9,
    encoding: encoding.encoding,
  };
  warnIfMismatched(result.format, options, budget, tiedFormats);
  return { result };
}

/** Bytes `sniff()` looks at. */
const SNIFF_BYTES = 64 * 1024;

/**
 * Name a file's format from its first bytes, synchronously and without opening anything (EXT-6):
 * magic numbers first, then the text kinds (JSON, XML, HTML, CSV/TSV, Markdown, plain text, and
 * the P1 text families). ZIP and compound (OLE) files are reported as `zip` and `ole`: telling DOCX
 * from XLSX needs their index, which `detect()` reads. Only the first 64 KiB are looked at.
 * File names and MIME types are not used; `detect()` weighs those hints.
 */
export function sniff(bytes: Uint8Array): DetectResult {
  const prefix = bytes.subarray(0, SNIFF_BYTES);
  const magic = hasTextBom(prefix) ? { kind: null, mimeType: null, confidence: 0 } : sniffMagic(prefix);
  if (magic.kind !== null) return makeResult(magic.kind, magic.confidence, magic.mimeType);
  const encoding = detectEncoding(prefix);
  if (!encoding.isText || encoding.encoding === 'unsupported')
    return { format: 'unknown', mimeType: mimeTypeForFormat('unknown'), confidence: 0 };
  const format =
    detectTextKindCandidates(decodeText(getTextPrefix(prefix, encoding.encoding), encoding.encoding))[0] ??
    'txt';
  return {
    format,
    mimeType: mimeTypeForFormat(format),
    confidence: format === 'txt' ? 0.65 : 0.9,
    encoding: encoding.encoding,
  };
}

/** Content kinds that YAML, NDJSON and the other text families can look like (flow lists look like CSV). */
const LOOSE_TEXT: ReadonlySet<FormatId> = new Set(['txt', 'markdown', 'csv', 'tsv']);

/** Text formats that a name or MIME type can select when the content only looks like plain text. */
const TEXT_FAMILY: ReadonlySet<FormatId> = new Set(['yaml', 'ndjson', 'ics', 'vcf', 'srt', 'vtt']);

function makeResult(format: FormatId, confidence: number, sniffedMimeType?: string | null): DetectResult {
  return {
    format,
    mimeType: sniffedMimeType ?? mimeTypeForFormat(format),
    confidence,
  };
}

function hasTextBom(bytes: Uint8Array): boolean {
  return (
    (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) ||
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  );
}

function getTextPrefix(bytes: Uint8Array, encoding: TextEncoding): Uint8Array {
  let end = Math.min(bytes.length, TEXT_SAMPLE_BYTES);
  if (encoding === 'utf-8') {
    let sequenceStart = end - 1;
    while (sequenceStart >= Math.max(0, end - 4) && isUtf8Continuation(bytes[sequenceStart] ?? 0)) {
      sequenceStart -= 1;
    }
    const lead = bytes[sequenceStart] ?? 0;
    const expectedLength = utf8SequenceLength(lead);
    const presentLength = end - sequenceStart;
    if (expectedLength > presentLength) {
      end = Math.min(bytes.length, end + expectedLength - presentLength);
    }
  } else if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    end -= end % 2;
    if (end >= 2 && bytes.length - end >= 2) {
      const last = readUtf16Unit(bytes, end - 2, encoding);
      const next = readUtf16Unit(bytes, end, encoding);
      if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end += 2;
    }
  }
  return bytes.subarray(0, end);
}

function isUtf8Continuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

function readUtf16Unit(bytes: Uint8Array, offset: number, encoding: 'utf-16le' | 'utf-16be'): number {
  const first = bytes[offset] ?? 0;
  const second = bytes[offset + 1] ?? 0;
  return encoding === 'utf-16le' ? first | (second << 8) : (first << 8) | second;
}

/** A root `EncryptedPackage` stream: an encrypted OOXML package ([MS-OFFCRYPTO] 2.3.4.4). */
function hasEncryptedPackage(entries: CfbArchive['entries'], budget: Budget): boolean {
  for (const entry of entries) {
    budget.tick();
    if (
      entry.type === 'stream' &&
      !entry.path.includes('/') &&
      entry.path.toLowerCase() === 'encryptedpackage'
    )
      return true;
  }
  return false;
}

function classifyCfb(entries: CfbArchive['entries'], budget: Budget): FormatId {
  const identities = new Set<FormatId>();

  for (const entry of entries) {
    budget.tick();
    if (entry.type !== 'stream' || entry.path.includes('/')) continue;
    if (entry.path === 'WordDocument') identities.add('doc');
    else if (entry.path === 'Workbook' || entry.path === 'Book') identities.add('xls');
    else if (entry.path === 'PowerPoint Document') identities.add('ppt');
    else if (entry.path === '__properties_version1.0') identities.add('msg');
  }

  if (identities.size !== 1) return 'ole';
  return identities.values().next().value ?? 'ole';
}

function warnIfMismatched(
  detected: FormatId,
  options: FormatHints,
  budget: Budget,
  tiedFormats?: ReadonlySet<FormatId>,
): void {
  const filenameHint = formatForFilename(options.filename);
  const mimeHint = formatForMimeType(options.mimeType);
  const differs = (hint: FormatId | undefined): boolean => {
    if (hint === undefined || hint === detected) return false;
    if (tiedFormats?.has(hint)) return false;
    return true;
  };
  const mismatches: string[] = [];
  if (differs(filenameHint)) mismatches.push(`filename format "${filenameHint}"`);
  if (differs(mimeHint)) mismatches.push(`MIME type format "${mimeHint}"`);
  if (mismatches.length === 0) return;

  budget.warnings.add({
    code: 'FORMAT_MISMATCH',
    message: `Detected format "${detected}" disagrees with ${mismatches.join(' and ')}.`,
  });
}

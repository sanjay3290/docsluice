import type { FormatId } from '../core/model.js';

const FORMAT_MIME = new Map<FormatId, string>([
  ['txt', 'text/plain'],
  ['markdown', 'text/markdown'],
  ['csv', 'text/csv'],
  ['tsv', 'text/tab-separated-values'],
  ['json', 'application/json'],
  ['xml', 'application/xml'],
  ['html', 'text/html'],
  ['yaml', 'application/yaml'],
  ['ndjson', 'application/x-ndjson'],
  ['ics', 'text/calendar'],
  ['vcf', 'text/vcard'],
  ['srt', 'application/x-subrip'],
  ['vtt', 'text/vtt'],
  ['rtf', 'application/rtf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['docm', 'application/vnd.ms-word.document.macroEnabled.12'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['xlsb', 'application/vnd.ms-excel.sheet.binary.macroEnabled.12'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  ['odt', 'application/vnd.oasis.opendocument.text'],
  ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
  ['odp', 'application/vnd.oasis.opendocument.presentation'],
  ['doc', 'application/msword'],
  ['xls', 'application/vnd.ms-excel'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pdf', 'application/pdf'],
  ['epub', 'application/epub+zip'],
  ['eml', 'message/rfc822'],
  ['mbox', 'application/mbox'],
  ['msg', 'application/vnd.ms-outlook'],
  ['pst', 'application/vnd.ms-outlook-pst'],
  ['zip', 'application/zip'],
  ['gzip', 'application/gzip'],
  ['tar', 'application/x-tar'],
  ['7z', 'application/x-7z-compressed'],
  ['rar', 'application/vnd.rar'],
  ['ole', 'application/x-ole-storage'],
  ['png', 'image/png'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['tiff', 'image/tiff'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['ico', 'image/x-icon'],
  ['audio', 'application/octet-stream'],
  ['video', 'application/octet-stream'],
  ['exe', 'application/vnd.microsoft.portable-executable'],
  ['unknown', 'application/octet-stream'],
]);

const MIME_FORMAT = new Map<string, FormatId>();
for (const [format, mimeType] of FORMAT_MIME) {
  if (format !== 'audio' && format !== 'video' && format !== 'unknown') MIME_FORMAT.set(mimeType, format);
}
MIME_FORMAT.set('application/x-elf', 'exe');
MIME_FORMAT.set('application/vnd.microsoft.portable-executable', 'exe');
MIME_FORMAT.set('application/x-mach-binary', 'exe');
MIME_FORMAT.set('image/jpg', 'jpeg');
MIME_FORMAT.set('text/x-markdown', 'markdown');
MIME_FORMAT.set('application/x-ndjson', 'ndjson');

const EXTENSION_FORMAT = new Map<string, FormatId>([
  ['txt', 'txt'],
  ['text', 'txt'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['csv', 'csv'],
  ['tsv', 'tsv'],
  ['json', 'json'],
  ['xml', 'xml'],
  ['html', 'html'],
  ['htm', 'html'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['ndjson', 'ndjson'],
  ['jsonl', 'ndjson'],
  ['ics', 'ics'],
  ['vcf', 'vcf'],
  ['srt', 'srt'],
  ['vtt', 'vtt'],
  ['rtf', 'rtf'],
  ['docx', 'docx'],
  ['docm', 'docm'],
  ['xlsx', 'xlsx'],
  ['xlsm', 'xlsm'],
  ['xlsb', 'xlsb'],
  ['pptx', 'pptx'],
  ['pptm', 'pptm'],
  ['odt', 'odt'],
  ['ods', 'ods'],
  ['odp', 'odp'],
  ['doc', 'doc'],
  ['xls', 'xls'],
  ['ppt', 'ppt'],
  ['pdf', 'pdf'],
  ['epub', 'epub'],
  ['eml', 'eml'],
  ['mbox', 'mbox'],
  ['msg', 'msg'],
  ['zip', 'zip'],
  ['gz', 'gzip'],
  ['gzip', 'gzip'],
  ['tar', 'tar'],
  ['png', 'png'],
  ['jpg', 'jpeg'],
  ['jpeg', 'jpeg'],
  ['gif', 'gif'],
  ['tif', 'tiff'],
  ['tiff', 'tiff'],
  ['webp', 'webp'],
]);

/** Return the canonical MIME type for a known format or the binary fallback. */
export function mimeTypeForFormat(format: string): string {
  return FORMAT_MIME.get(format) ?? 'application/octet-stream';
}

/** Resolve a MIME hint without parameters, case-insensitively. */
export function formatForMimeType(mimeType: string | undefined): FormatId | undefined {
  if (mimeType === undefined) return undefined;
  return MIME_FORMAT.get(normalizeMimeType(mimeType));
}

/** Resolve only the final extension of a filename hint; no filesystem access is used. */
export function formatForFilename(filename: string | undefined): FormatId | undefined {
  if (filename === undefined) return undefined;
  const basename = filename.slice(Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\')) + 1);
  const dot = basename.lastIndexOf('.');
  if (dot < 0 || dot === basename.length - 1) return undefined;
  return EXTENSION_FORMAT.get(basename.slice(dot + 1).toLowerCase());
}

function normalizeMimeType(mimeType: string): string {
  const separator = mimeType.indexOf(';');
  return (separator < 0 ? mimeType : mimeType.slice(0, separator)).trim().toLowerCase();
}

/** Source files whose `#` comments look like Markdown headings; such files stay plain text. */
const HASH_COMMENT_SOURCE = /\.(?:bash|ini|pl|ps1|py|r|rb|sh|toml|zsh)$/i;

/** Whether a file name is source code whose comments start with `#`. */
export function isHashCommentSource(filename: string | undefined): boolean {
  return filename !== undefined && HASH_COMMENT_SOURCE.test(filename);
}

import type { Budget } from '../core/budget.js';
import type { FormatId } from '../core/model.js';
import { scanXml } from '../xml/index.js';
import { openZip } from '../zip/index.js';
import type { ZipArchive, ZipEntry } from '../zip/index.js';

const CONTENT_TYPES_NAME = '[Content_Types].xml';
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types';
const MAX_MARKER_BYTES = 1024 * 1024;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const OOXML_MAIN_PARTS = new Map<string, FormatId>([
  [
    '/word/document.xml\u0000application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'docx',
  ],
  ['/word/document.xml\u0000application/vnd.ms-word.document.macroEnabled.main+xml', 'docm'],
  [
    '/xl/workbook.xml\u0000application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    'xlsx',
  ],
  ['/xl/workbook.xml\u0000application/vnd.ms-excel.sheet.macroEnabled.main+xml', 'xlsm'],
  ['/xl/workbook.bin\u0000application/vnd.ms-excel.sheet.binary.macroEnabled.main', 'xlsb'],
  [
    '/ppt/presentation.xml\u0000application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'pptx',
  ],
  ['/ppt/presentation.xml\u0000application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml', 'pptm'],
  ['/visio/document.xml\u0000application/vnd.ms-visio.drawing.main+xml', 'vsdx'],
]);

const MIMETYPES = new Map<string, FormatId>([
  ['application/vnd.oasis.opendocument.text', 'odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', 'ods'],
  ['application/vnd.oasis.opendocument.presentation', 'odp'],
  ['application/epub+zip', 'epub'],
]);

export interface ZipKindResult {
  format: FormatId;
  zip: ZipArchive;
}

/** Classify common document ZIPs while returning the single opened archive to its reader. */
export async function detectZipKind(bytes: Uint8Array, budget: Budget): Promise<ZipKindResult> {
  const zip = openZip(bytes, budget);
  const contentTypesEntry = uniqueEntry(zip, CONTENT_TYPES_NAME, budget);

  let ooxml: FormatId | undefined;
  if (contentTypesEntry) {
    const marker = await readMarker(zip, contentTypesEntry, budget);
    if (marker) ooxml = scanContentTypes(marker, budget);
  }

  let mimetype: FormatId | undefined;
  const mimetypeEntry = uniqueEntry(zip, 'mimetype', budget);
  if (
    mimetypeEntry &&
    isPhysicalFirstMimetype(bytes, budget) &&
    mimetypeEntry.compressionMethod === 0 &&
    !mimetypeEntry.isUnreadable
  ) {
    const marker = await readMarker(zip, mimetypeEntry, budget);
    if (marker) mimetype = decodeMimetype(marker);
  }

  // Two independently recognized package identities make the archive ambiguous.
  if (ooxml && mimetype && ooxml !== mimetype) return { format: 'zip', zip };
  return { format: ooxml ?? mimetype ?? 'zip', zip };
}

function isPhysicalFirstMimetype(bytes: Uint8Array, budget: Budget): boolean {
  if (bytes.length < 30) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) return false;
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const headerEnd = 30 + nameLength + extraLength;
  if (method !== 0 || (flags & 0x41) !== 0 || nameLength !== 8 || headerEnd > bytes.length) {
    return false;
  }
  const name = 'mimetype';
  for (let index = 0; index < nameLength; index += 1) {
    budget.tick();
    if (bytes[30 + index] !== name.charCodeAt(index)) return false;
  }
  return true;
}

function uniqueEntry(zip: ZipArchive, name: string, budget: Budget): ZipEntry | undefined {
  let found: ZipEntry | undefined;
  for (const entry of zip.entries) {
    budget.tick();
    if (entry.name !== name) continue;
    if (found) return undefined;
    found = entry;
  }
  return found;
}

async function readMarker(zip: ZipArchive, entry: ZipEntry, budget: Budget): Promise<Uint8Array | null> {
  const remaining = budget.limits.totalUncompressedBytes - budget.totalUncompressedBytes;
  if (entry.uncompressedSize > remaining) {
    if (!budget.checkUncompressed(entry.uncompressedSize)) return null;
  }
  // This local parsing cap is applied before `read`, which otherwise materializes the full part.
  if (entry.uncompressedSize > MAX_MARKER_BYTES) {
    budget.warnings.add({
      code: 'UNREADABLE_PART',
      message: 'An oversized ZIP classification marker was skipped.',
    });
    return null;
  }
  return zip.read(entry);
}

function scanContentTypes(bytes: Uint8Array, budget: Budget): FormatId | undefined {
  let inTypesRoot = false;
  let depth = 0;
  let rootCount = 0;
  let multipleRoots = false;
  const found = new Set<FormatId>();
  scanXml(
    bytes,
    {
      onOpen(_name, attrs, info) {
        if (depth === 0) {
          rootCount += 1;
          if (rootCount > 1) multipleRoots = true;
          inTypesRoot = info.localName === 'Types' && info.namespaceURI === CONTENT_TYPES_NAMESPACE;
        } else if (
          depth === 1 &&
          !multipleRoots &&
          inTypesRoot &&
          info.localName === 'Override' &&
          info.namespaceURI === CONTENT_TYPES_NAMESPACE
        ) {
          const partName = attrs.get('PartName');
          const contentType = attrs.get('ContentType');
          if (partName !== undefined && contentType !== undefined) {
            const format = OOXML_MAIN_PARTS.get(`${partName}\u0000${contentType}`);
            if (format) found.add(format);
          }
        }
        depth += 1;
      },
      onClose() {
        depth -= 1;
        if (depth === 0) {
          // Multiple document elements are malformed and cannot establish a package type.
          inTypesRoot = false;
        }
      },
    },
    { budget, warnings: budget.warnings },
  );
  return !multipleRoots && found.size === 1 ? found.values().next().value : undefined;
}

function decodeMimetype(bytes: Uint8Array): FormatId | undefined {
  try {
    const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return MIMETYPES.get(value);
  } catch {
    return undefined;
  }
}

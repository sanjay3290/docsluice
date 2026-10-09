import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { resolveLimits } from '../../src/core/limits.js';
import { LimitExceededError } from '../../src/core/errors.js';
import { detectZipKind } from '../../src/detect/zip-kind.js';
import { makeZip } from '../helpers/zip.js';

const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const DOCX_MAIN_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

function contentTypes(partName: string, contentType: string, namespace = CONTENT_TYPES_NS): Uint8Array {
  return new TextEncoder().encode(
    `<Types xmlns="${namespace}"><Override PartName="${partName}" ContentType="${contentType}"/></Types>`,
  );
}

const ooxmlCases = [
  ['docx', '/word/document.xml', DOCX_MAIN_TYPE],
  ['docm', '/word/document.xml', 'application/vnd.ms-word.document.macroEnabled.main+xml'],
  ['xlsx', '/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  ['xlsm', '/xl/workbook.xml', 'application/vnd.ms-excel.sheet.macroEnabled.main+xml'],
  ['xlsb', '/xl/workbook.bin', 'application/vnd.ms-excel.sheet.binary.macroEnabled.main'],
  [
    'pptx',
    '/ppt/presentation.xml',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  ],
  ['pptm', '/ppt/presentation.xml', 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'],
  ['vsdx', '/visio/document.xml', 'application/vnd.ms-visio.drawing.main+xml'],
] as const;

function budget(totalUncompressedBytes = 500_000_000, onLimit: 'truncate' | 'throw' = 'throw'): Budget {
  return new Budget(resolveLimits({ totalUncompressedBytes }), { onLimit });
}

function docxContentTypes(): Uint8Array {
  return contentTypes('/word/document.xml', DOCX_MAIN_TYPE);
}

function reorderCentralEntries(bytes: Uint8Array, order: readonly number[]): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endRecord = bytes.length - 22;
  const start = view.getUint32(endRecord + 16, true);
  const records: Uint8Array[] = [];
  let cursor = start;
  while (cursor < endRecord) {
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    records.push(bytes.slice(cursor, next));
    cursor = next;
  }
  const result = bytes.slice();
  cursor = start;
  for (const recordIndex of order) {
    const record = records[recordIndex];
    if (!record) throw new RangeError('Invalid central entry order');
    result.set(record, cursor);
    cursor += record.length;
  }
  return result;
}

describe('detectZipKind', () => {
  it.each(ooxmlCases)(
    'detects %s from the namespace-aware main-part override',
    async (format, part, type) => {
      const bytes = makeZip([
        { name: '[Content_Types].xml', data: contentTypes(part, type) },
        { name: 'word/not-the-main-part.xml', data: new TextEncoder().encode('') },
      ]);
      const result = await detectZipKind(bytes, budget());
      expect(result.format).toBe(format);
      expect(result.zip.entries).toHaveLength(2);
    },
  );

  it.each([
    ['odt', 'application/vnd.oasis.opendocument.text'],
    ['ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['odp', 'application/vnd.oasis.opendocument.presentation'],
    ['epub', 'application/epub+zip'],
  ] as const)('detects %s from the first stored mimetype entry', async (format, type) => {
    const result = await detectZipKind(
      makeZip([
        { name: 'mimetype', data: new TextEncoder().encode(type), method: 0 },
        { name: 'content.xml', data: new TextEncoder().encode('') },
      ]),
      budget(),
    );
    expect(result.format).toBe(format);
  });

  it('uses physical local-header order even if central-directory order differs', async () => {
    const physicalFirst = reorderCentralEntries(
      makeZip([
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
        { name: 'other', data: new Uint8Array() },
      ]),
      [1, 0],
    );
    const physicalSecond = reorderCentralEntries(
      makeZip([
        { name: 'other', data: new Uint8Array() },
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
      ]),
      [1, 0],
    );
    expect((await detectZipKind(physicalFirst, budget())).format).toBe('epub');
    expect((await detectZipKind(physicalSecond, budget())).format).toBe('zip');
  });

  it('does not classify duplicate mimetype entries', async () => {
    const result = await detectZipKind(
      makeZip([
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
        { name: 'mimetype', data: new TextEncoder().encode('application/vnd.oasis.opendocument.text') },
      ]),
      budget(),
    );
    expect(result.format).toBe('zip');
  });

  it('returns plain zip for unknown archives and content-type text without a valid main override', async () => {
    const unknown = await detectZipKind(
      makeZip([{ name: 'readme.txt', data: new TextEncoder().encode('docx') }]),
      budget(),
    );
    const fake = await detectZipKind(
      makeZip([
        {
          name: '[Content_Types].xml',
          data: new TextEncoder().encode(
            `<Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
          ),
        },
      ]),
      budget(),
    );
    expect(unknown.format).toBe('zip');
    expect(fake.format).toBe('zip');
  });

  it('requires the content-types namespace and recognized main part', async () => {
    const wrongNamespace = await detectZipKind(
      makeZip([
        {
          name: '[Content_Types].xml',
          data: contentTypes('/word/document.xml', ooxmlCases[0][2], 'urn:attacker'),
        },
      ]),
      budget(),
    );
    const wrongPart = await detectZipKind(
      makeZip([
        { name: '[Content_Types].xml', data: contentTypes('/custom/document.xml', ooxmlCases[0][2]) },
      ]),
      budget(),
    );
    expect(wrongNamespace.format).toBe('zip');
    expect(wrongPart.format).toBe('zip');
  });

  it('resolves prefixed content-types namespaces and ignores nested overrides', async () => {
    const prefixed = new TextEncoder().encode(
      `<ct:Types xmlns:ct="${CONTENT_TYPES_NS}"><ct:Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_TYPE}"/></ct:Types>`,
    );
    const nestedOnly = new TextEncoder().encode(
      `<Types xmlns="${CONTENT_TYPES_NS}"><Extension><Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_TYPE}"/></Extension></Types>`,
    );
    const result = await detectZipKind(makeZip([{ name: '[Content_Types].xml', data: prefixed }]), budget());
    const nested = await detectZipKind(
      makeZip([{ name: '[Content_Types].xml', data: nestedOnly }]),
      budget(),
    );
    expect(result.format).toBe('docx');
    expect(nested.format).toBe('zip');
  });

  it('does not classify a mimetype entry unless it is first and stored', async () => {
    const afterFirst = await detectZipKind(
      makeZip([
        { name: 'first', data: new Uint8Array() },
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
      ]),
      budget(),
    );
    const deflated = await detectZipKind(
      makeZip([{ name: 'mimetype', data: new TextEncoder().encode('application/epub+zip'), method: 8 }]),
      budget(),
    );
    expect(afterFirst.format).toBe('zip');
    expect(deflated.format).toBe('zip');
  });

  it('does not classify an encrypted first mimetype entry', async () => {
    const result = await detectZipKind(
      makeZip([
        {
          name: 'mimetype',
          data: new TextEncoder().encode('application/epub+zip'),
          flags: 0x0801,
        },
      ]),
      budget(),
    );
    expect(result.format).toBe('zip');
  });

  it('treats invalid UTF-8 mimetype data as an unknown ZIP marker', async () => {
    const result = await detectZipKind(
      makeZip([{ name: 'mimetype', data: new Uint8Array([0xff, 0xfe]) }]),
      budget(),
    );
    expect(result.format).toBe('zip');
  });

  it('returns zip when recognized OOXML and ODF/EPUB markers conflict', async () => {
    const conflict = await detectZipKind(
      makeZip([
        { name: 'mimetype', data: new TextEncoder().encode('application/epub+zip') },
        { name: '[Content_Types].xml', data: docxContentTypes() },
      ]),
      budget(),
    );
    expect(conflict.format).toBe('zip');
  });

  it('charges the marker once and returns the same opened archive for a later reader', async () => {
    const archiveBytes = makeZip([
      { name: '[Content_Types].xml', data: docxContentTypes() },
      { name: 'word/document.xml', data: new TextEncoder().encode('<w:document/>') },
    ]);
    const sharedBudget = budget();
    const result = await detectZipKind(archiveBytes, sharedBudget);
    expect(sharedBudget.totalUncompressedBytes).toBe(docxContentTypes().length);
    const read = vi.spyOn(result.zip, 'read');
    const documentEntry = result.zip.entries[1]!;
    expect(await result.zip.read(documentEntry)).toEqual(new TextEncoder().encode('<w:document/>'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(sharedBudget.totalUncompressedBytes).toBeGreaterThan(docxContentTypes().length);
  });

  it('rejects an oversized declared content-types marker before reading or allocating it', async () => {
    const zip = makeZip([
      {
        name: '[Content_Types].xml',
        data: new TextEncoder().encode(`<Types xmlns="${CONTENT_TYPES_NS}"/>`),
        declaredSize: 50 * 1024 * 1024,
      },
    ]);
    const normalBudget = budget();
    const normalResult = await detectZipKind(zip, normalBudget);
    expect(normalResult.format).toBe('zip');
    expect(normalBudget.totalUncompressedBytes).toBe(0);
    expect(normalBudget.warnings.warnings).toMatchObject([{ code: 'UNREADABLE_PART' }]);

    await expect(detectZipKind(zip, budget(1024))).rejects.toEqual(
      new LimitExceededError('totalUncompressedBytes', 1024),
    );
    const truncatingBudget = budget(1024, 'truncate');
    expect((await detectZipKind(zip, truncatingBudget)).format).toBe('zip');
    expect(truncatingBudget.truncated).toBe(true);
    expect(truncatingBudget.warnings.warnings).toMatchObject([{ code: 'TRUNCATED' }]);
  });

  it('skips the committed 50 MiB classification-marker hostile fixture', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../hostile/zip/content-types-50mb.zip', import.meta.url)),
    );
    const sharedBudget = budget();
    const result = await detectZipKind(bytes, sharedBudget);
    expect(result.format).toBe('zip');
    expect(sharedBudget.totalUncompressedBytes).toBe(0);
    expect(sharedBudget.warnings.warnings).toMatchObject([{ code: 'UNREADABLE_PART' }]);
  });

  it('uses Map-backed parsed attributes for hostile prototype-like content', async () => {
    const xml = new TextEncoder().encode(
      `<Types xmlns="${CONTENT_TYPES_NS}"><Override PartName="/word/document.xml" ContentType="${ooxmlCases[0][2]}" __proto__="polluted" constructor="x"/></Types>`,
    );
    const before = Object.getOwnPropertyNames(Object.prototype);
    const result = await detectZipKind(makeZip([{ name: '[Content_Types].xml', data: xml }]), budget());
    expect(result.format).toBe('docx');
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(before);
  });
});

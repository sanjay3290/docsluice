import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../src/core/budget.js';
import { LimitExceededError } from '../../src/core/errors.js';
import { EncryptedError } from '../../src/core/errors.js';
import { resolveLimits } from '../../src/core/limits.js';
import { detect, resolveFormat } from '../../src/detect/detect.js';
import { makeZip } from '../helpers/zip.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('public detect', () => {
  it('trusts a PNG signature over a PDF filename and MIME hint', async () => {
    const result = await detect(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });

    expect(result).toEqual({ format: 'png', mimeType: 'image/png', confidence: 1 });
  });

  it('records a mismatch when report.pdf contains a PNG', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const budget = new Budget(resolveLimits());
    const result = await resolveFormat(
      bytes,
      { filename: 'report.pdf', mimeType: 'application/pdf' },
      budget,
    );

    expect(result.result.format).toBe('png');
    expect(budget.warnings.warnings).toMatchObject([
      {
        code: 'FORMAT_MISMATCH',
        message: 'Detected format "png" disagrees with filename format "pdf" and MIME type format "pdf".',
      },
    ]);
  });

  it('does not treat a generic binary MIME hint as a format mismatch', async () => {
    const result = await detect(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      mimeType: 'application/octet-stream',
      strict: ['FORMAT_MISMATCH'],
    });

    expect(result.format).toBe('png');
  });

  it('returns only the established detection result shape', async () => {
    const result = await detect(encode('plain text'));

    expect(Object.keys(result)).toEqual(['format', 'mimeType', 'confidence', 'encoding']);
    expect(result).toMatchObject({ format: 'txt', mimeType: 'text/plain', encoding: 'utf-8' });
  });

  it('forces a requested format without inspecting bytes', async () => {
    const result = await detect(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), {
      format: 'csv',
    });

    expect(result).toEqual({ format: 'csv', mimeType: 'text/csv', confidence: 1 });
  });

  it.each([
    [encode('{"ok":true}'), 'json', 'utf-8'],
    [Uint8Array.from([0xef, 0xbb, 0xbf, ...encode('# heading')]), 'markdown', 'utf-8'],
    [Uint8Array.from([0x80, 0x93, 0x68, 0x69, 0x94]), 'txt', 'windows-1252'],
    [Uint8Array.from([0xff, 0xfe, 0x41, 0, 0xac, 0x20]), 'txt', 'utf-16le'],
  ] as const)('detects bounded text sample as %s', async (bytes, format, encoding) => {
    await expect(detect(bytes)).resolves.toMatchObject({ format, encoding });
  });

  it('keeps a valid UTF-8 code point that crosses the 8 KiB probe boundary', async () => {
    const bytes = encode(`${'a'.repeat(8191)}é`);

    await expect(detect(bytes)).resolves.toMatchObject({ format: 'txt', encoding: 'utf-8' });
    await expect(detect(bytes, { strict: ['ENCODING_GUESSED'] })).resolves.toMatchObject({
      format: 'txt',
      encoding: 'utf-8',
    });
  });

  it('uses a filename extension only to break a text-kind tie', async () => {
    const result = await detect(encode('just some words'), { filename: 'notes.md' });

    expect(result.format).toBe('markdown');
  });

  it('uses a MIME hint only to break a text-kind tie', async () => {
    const result = await detect(encode('just some words'), { mimeType: 'text/markdown' });

    expect(result.format).toBe('markdown');
  });

  it('uses a TSV hint to resolve a consistent comma-and-tab delimiter tie', async () => {
    const result = await detect(encode('a,b\tc,d\n1,2\t3,4'), { filename: 'values.tsv' });

    expect(result.format).toBe('tsv');
  });

  it('does not let a TSV hint override unambiguous CSV structure', async () => {
    const result = await detect(encode('a,b\n1,2'), { filename: 'values.tsv' });

    expect(result.format).toBe('csv');
  });

  it.each([
    ['{"ok":true}', 'json', 'application/json'],
    ['<?xml version="1.0"?><root/>', 'xml', 'application/xml'],
    ['<!doctype html><html><body>hi</body></html>', 'html', 'text/html'],
    ['name,value\na,1\nb,2', 'csv', 'text/csv'],
    ['name\tvalue\na\t1\nb\t2', 'tsv', 'text/tab-separated-values'],
    ['# heading\ntext', 'markdown', 'text/markdown'],
    ['plain words', 'txt', 'text/plain'],
  ] as const)('classifies P0 text kind %s as %s', async (text, format, mimeType) => {
    await expect(detect(encode(text))).resolves.toMatchObject({ format, mimeType, encoding: 'utf-8' });
  });

  it('normalizes Blob and web ReadableStream inputs under the same detector', async () => {
    await expect(detect(new Blob(['{"from":"blob"}']))).resolves.toMatchObject({ format: 'json' });

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('# from stream'));
        controller.close();
      },
    });
    await expect(detect(stream)).resolves.toMatchObject({ format: 'markdown' });
  });

  it('throws on a strict format mismatch without exposing document content', async () => {
    await expect(
      detect(encode('secret words'), { filename: 'report.pdf', strict: ['FORMAT_MISMATCH'] }),
    ).rejects.toMatchObject({
      name: 'StrictModeError',
      code: 'STRICT_WARNING',
      warningCode: 'FORMAT_MISMATCH',
    });
  });

  it('does not let a filename override structured text detection', async () => {
    const result = await detect(encode('{"private":"value"}'), { filename: 'notes.txt' });

    expect(result.format).toBe('json');
  });

  it('uses a recognized MIME mismatch as a strict warning', async () => {
    const error = detect(encode('<root/>'), {
      mimeType: 'application/pdf',
      strict: ['FORMAT_MISMATCH'],
    });

    await expect(error).rejects.toMatchObject({
      name: 'StrictModeError',
      code: 'STRICT_WARNING',
      warningCode: 'FORMAT_MISMATCH',
    });
    await expect(error).rejects.not.toThrow(/root/);
  });

  it('records an internal mismatch warning with format names and no input text', async () => {
    const budget = new Budget(resolveLimits());
    const result = await resolveFormat(
      encode('{"private":"top secret"}'),
      { filename: 'report.pdf' },
      budget,
    );
    const warning = budget.warnings.warnings[0];

    expect(result.result.format).toBe('json');
    expect(warning).toMatchObject({
      code: 'FORMAT_MISMATCH',
      message: 'Detected format "json" disagrees with filename format "pdf".',
    });
    expect(warning?.message).not.toContain('top secret');
  });

  it('warns when unknown binary bytes have a recognized document hint', async () => {
    const bytes = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
    const budget = new Budget(resolveLimits());
    const result = await resolveFormat(bytes, { filename: 'report.pdf' }, budget);

    expect(result.result.format).toBe('unknown');
    expect(budget.warnings.warnings).toMatchObject([
      { code: 'FORMAT_MISMATCH', message: 'Detected format "unknown" disagrees with filename format "pdf".' },
    ]);
    await expect(
      detect(bytes, { filename: 'report.pdf', strict: ['FORMAT_MISMATCH'] }),
    ).rejects.toMatchObject({
      name: 'StrictModeError',
      warningCode: 'FORMAT_MISMATCH',
    });
  });

  it('recognizes executables independently of a document-looking filename', async () => {
    const result = await detect(Uint8Array.from([0x4d, 0x5a]), { filename: 'invoice.pdf' });

    expect(result).toEqual({
      format: 'exe',
      mimeType: 'application/vnd.microsoft.portable-executable',
      confidence: 1,
    });
  });

  it('charges supplied input exactly once against the input budget', async () => {
    await expect(detect(encode('hello'), { limits: { inputBytes: 4 } })).rejects.toBeInstanceOf(
      LimitExceededError,
    );
    await expect(detect(encode('hello'), { limits: { inputBytes: 5 } })).resolves.toMatchObject({
      format: 'txt',
    });
  });

  it('detects each P0 binary signature exposed by the magic sniffer', async () => {
    const samples: Array<[Uint8Array, string, string]> = [
      [encode('%PDF-1.7'), 'pdf', 'application/pdf'],
      [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'png', 'image/png'],
      [Uint8Array.from([0xff, 0xd8, 0xff]), 'jpeg', 'image/jpeg'],
      [encode('GIF89a'), 'gif', 'image/gif'],
      [Uint8Array.from([0x49, 0x49, 0x2a, 0x00]), 'tiff', 'image/tiff'],
      [encode('RIFF0000WEBP'), 'webp', 'image/webp'],
    ];

    for (const [bytes, format, mimeType] of samples) {
      await expect(detect(bytes)).resolves.toMatchObject({ format, mimeType });
    }
  });

  it.each([
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'word/document.xml'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xl/workbook.xml'],
    [
      'pptx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'ppt/presentation.xml',
    ],
  ] as const)('classifies %s and reads only its package marker', async (format, mimeType, part) => {
    const mainTypes = new Map([
      [
        'word/document.xml',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
      ],
      ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      [
        'ppt/presentation.xml',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      ],
    ]);
    const marker = encode(
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${part}" ContentType="${mainTypes.get(part)}"/></Types>`,
    );
    const bytes = makeZip([
      { name: '[Content_Types].xml', data: marker },
      { name: part, data: encode('payload') },
    ]);
    const budget = new Budget(resolveLimits());
    budget.addInputBytes(bytes.byteLength);
    const result = await resolveFormat(bytes, { filename: `report.${format}` }, budget);

    expect(result.result.format).toBe(format);
    expect(result.result.mimeType).toBe(mimeType);
    expect(result.result.confidence).toBeGreaterThan(0);
    expect(result.zip).toBeDefined();
    expect(budget.inputBytes).toBe(bytes.byteLength);
    expect(budget.totalUncompressedBytes).toBe(marker.byteLength);
    expect(await result.zip!.read(result.zip!.entries[1]!)).toEqual(encode('payload'));
  });

  it('classifies an unknown ZIP as generic ZIP', async () => {
    const result = await detect(makeZip([{ name: 'readme.txt', data: encode('hello') }]));

    expect(result).toMatchObject({ format: 'zip', mimeType: 'application/zip' });
  });

  it.each([
    ['libreoffice.doc', 'doc', 'application/msword'],
    ['libreoffice.xls', 'xls', 'application/vnd.ms-excel'],
    ['libreoffice.ppt', 'ppt', 'application/vnd.ms-powerpoint'],
    ['test_outlook_msg.msg', 'msg', 'application/vnd.ms-outlook'],
  ] as const)(
    'classifies the existing %s compound file from stream names',
    async (name, format, mimeType) => {
      const bytes = new Uint8Array(readFileSync(new URL(`../../../../corpus/ole/${name}`, import.meta.url)));
      const budget = new Budget(resolveLimits());
      budget.addInputBytes(bytes.byteLength);
      const result = await resolveFormat(bytes, {}, budget);

      expect(result.result).toMatchObject({ format, mimeType });
      expect(result.cfb).toBeDefined();
      expect(budget.inputBytes).toBe(bytes.byteLength);
    },
  );

  it('keeps ambiguous root CFB stream identities generic', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../corpus/ole/libreoffice.doc', import.meta.url)),
    );
    renameDirectoryStream(bytes, '1Table', 'Workbook');

    await expect(detect(bytes)).resolves.toMatchObject({
      format: 'ole',
      mimeType: 'application/x-ole-storage',
    });
  });

  it('rejects an OLE package containing an EncryptedPackage stream', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../corpus/ole/libreoffice.doc', import.meta.url)),
    );
    renameDirectoryStream(bytes, 'WordDocument', 'EncryptedPackage');

    await expect(detect(bytes)).rejects.toBeInstanceOf(EncryptedError);
  });
});

function encodeUtf16Le(value: string): Uint8Array {
  const result = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    result[index * 2] = value.charCodeAt(index);
  }
  return result;
}

function findBytes(input: Uint8Array, search: Uint8Array): number {
  for (let start = 0; start <= input.length - search.length; start += 1) {
    let matches = true;
    for (let index = 0; index < search.length; index += 1) {
      if (input[start + index] !== search[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return start;
  }
  return -1;
}

function renameDirectoryStream(bytes: Uint8Array, from: string, to: string): void {
  const offset = findBytes(bytes, encodeUtf16Le(from));
  if (offset < 0) throw new RangeError('Directory stream name was not found.');
  const replacement = encodeUtf16Le(to);
  bytes.fill(0, offset, offset + 64);
  bytes.set(replacement, offset);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    offset + 64,
    replacement.length + 2,
    true,
  );
}

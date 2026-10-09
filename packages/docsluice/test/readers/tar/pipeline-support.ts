import { readFileSync } from 'node:fs';
import { reader as gzipReader } from '../../../src/readers/gzip/index.js';
import { reader as tarReader } from '../../../src/readers/tar/index.js';
import type { Reader, ReadContext } from '../../../src/core/reader.js';
import { createExtractor } from '../../../src/core/extract.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import { CorruptFileError } from '../../../src/core/errors.js';

export interface PipelineEntry {
  name: string;
  data: Uint8Array;
}

export function archiveFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../../corpus/tar/${name}`, import.meta.url)));
}

/** Small, bounded ustar writer for test-only in-memory pipeline inputs. */
export function makeTar(entries: readonly PipelineEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const put = (offset: number, length: number, value: string): void => {
      header.set(new TextEncoder().encode(value).subarray(0, length), offset);
    };
    const octal = (offset: number, length: number, value: number): void => {
      put(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    };
    put(0, 100, entry.name);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, entry.data.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    put(148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, entry.data);
    const padding = (512 - (entry.data.length % 512)) % 512;
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export function makeArchivePipeline(): {
  extract: ReturnType<typeof createExtractor>;
  getTextReaderLoads: () => number;
  getCsvReaderLoads: () => number;
} {
  const registry = new ReaderRegistry();
  registry.add({ id: 'gzip', mimeTypes: gzipReader.mimeTypes, load: () => Promise.resolve(gzipReader) });
  registry.add({ id: 'tar', mimeTypes: tarReader.mimeTypes, load: () => Promise.resolve(tarReader) });

  let textReaderLoads = 0;
  let csvReaderLoads = 0;
  const textReader: Reader = {
    id: 'txt',
    mimeTypes: ['text/plain'],
    read(ctx: ReadContext) {
      const text = new TextDecoder().decode(ctx.bytes);
      if (text.startsWith('!pipeline-fail!')) throw new CorruptFileError('Private fixture content.');
      ctx.out.paragraph(text);
      return Promise.resolve();
    },
  };
  const csvObserver: Reader = {
    id: 'csv',
    mimeTypes: ['text/csv'],
    read(ctx: ReadContext) {
      // This test-only observer proves pipeline routing and byte preservation;
      // it is not a CSV parser or golden acceptance test.
      ctx.out.paragraph(new TextDecoder().decode(ctx.bytes));
      return Promise.resolve();
    },
  };
  registry.add({
    id: 'txt',
    mimeTypes: textReader.mimeTypes,
    load: () => {
      textReaderLoads += 1;
      return Promise.resolve(textReader);
    },
  });
  registry.add({
    id: 'csv',
    mimeTypes: csvObserver.mimeTypes,
    load: () => {
      csvReaderLoads += 1;
      return Promise.resolve(csvObserver);
    },
  });
  return {
    extract: createExtractor(registry),
    getTextReaderLoads: () => textReaderLoads,
    getCsvReaderLoads: () => csvReaderLoads,
  };
}

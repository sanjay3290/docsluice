import { describe, expect, it } from 'vitest';
import { createExtractor } from '../../../src/core/extract.js';
import type { Reader } from '../../../src/core/reader.js';
import { ReaderRegistry } from '../../../src/core/registry.js';
import { zipReader } from '../../../src/readers/zip/index.js';
import { makeZip } from '../../helpers/zip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('ZIP mixed child output order regression (preparation-only, expected red)', () => {
  it('preserves central-directory order across extracted, skipped, and failed children', async () => {
    const registry = new ReaderRegistry();
    registry.add({
      id: 'zip',
      mimeTypes: ['application/zip'],
      load: () => Promise.resolve(zipReader),
    });
    const textReader: Reader = {
      id: 'txt',
      mimeTypes: ['text/plain'],
      read(ctx) {
        const text = decoder.decode(ctx.bytes);
        if (text === 'expected reader failure') throw new Error('synthetic test reader failure');
        ctx.out.paragraph(text);
        return Promise.resolve();
      },
    };
    registry.add({
      id: 'txt',
      mimeTypes: ['text/plain'],
      load: () => Promise.resolve(textReader),
    });

    // Directory children occupy first, middle, and last central-directory positions.
    const archive = makeZip([
      { name: 'directory-first/', data: new Uint8Array() },
      { name: 'first.txt', data: encoder.encode('first') },
      { name: 'failed.txt', data: encoder.encode('expected reader failure') },
      { name: 'directory-middle/', data: new Uint8Array() },
      { name: 'second.txt', data: encoder.encode('second') },
      { name: 'directory-last/', data: new Uint8Array() },
    ]);
    const document = await createExtractor(registry)(archive);

    expect(document.children.map(({ name, status }) => [name, status])).toEqual([
      ['directory-first/', 'skipped'],
      ['first.txt', 'extracted'],
      ['failed.txt', 'failed'],
      ['directory-middle/', 'skipped'],
      ['second.txt', 'extracted'],
      ['directory-last/', 'skipped'],
    ]);
  });
});

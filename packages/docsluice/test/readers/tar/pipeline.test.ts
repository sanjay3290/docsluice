import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { CorruptFileError } from '../../../src/core/errors.js';
import { archiveFixture, makeArchivePipeline, makeTar } from './pipeline-support.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('TAR extraction pipeline', () => {
  it('extracts regular children in archive order with nested paths and optional raw bytes', async () => {
    const pipeline = makeArchivePipeline();
    const first = text('first document');
    const second = text('second document');
    const document = await pipeline.extract(
      makeTar([
        { name: 'folder/first.txt', data: first },
        { name: 'folder/nested/second.txt', data: second },
      ]),
      { childBytes: true },
    );

    expect(document.format).toBe('tar');
    expect(document.children.map(({ path }) => path)).toEqual([
      'folder/first.txt',
      'folder/nested/second.txt',
    ]);
    expect(document.children.map(({ status }) => status)).toEqual(['extracted', 'extracted']);
    expect(document.children[0]?.bytes).toEqual(first);
    expect(document.children[1]?.bytes).toEqual(second);
    expect(document.children.map(({ document: child }) => child?.blocks[0]?.loc.path)).toEqual([
      'folder/first.txt',
      'folder/nested/second.txt',
    ]);
    expect(document.children.map(({ document: child }) => child?.format)).toEqual(['txt', 'txt']);
  });

  it('isolates a failed nested child and continues with later entries in order', async () => {
    const pipeline = makeArchivePipeline();
    const document = await pipeline.extract(
      makeTar([
        { name: '01-broken.txt', data: text('!pipeline-fail! private fixture') },
        { name: '02-good.txt', data: text('safe result') },
      ]),
    );

    expect(document.children.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: '01-broken.txt', status: 'failed' },
      { path: '02-good.txt', status: 'extracted' },
    ]);
    expect(document.children[0]?.error).toEqual({
      code: 'CORRUPT_FILE',
      message: 'The child document could not be read.',
    });
    expect(JSON.stringify(document.children[0]?.error)).not.toContain('private fixture');
    expect(document.children[1]?.document?.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'safe result',
    });
  });

  it('lists children without loading their readers and skips all children in skip mode', async () => {
    const archive = makeTar([
      { name: 'one.txt', data: text('list without parsing') },
      { name: 'two.txt', data: text('skip without parsing') },
    ]);
    const listedPipeline = makeArchivePipeline();
    const listed = await listedPipeline.extract(archive, { children: 'list' });
    expect(listed.children.map(({ status }) => status)).toEqual(['listed', 'listed']);
    expect(listed.children.every(({ document }) => document === undefined)).toBe(true);
    expect(listedPipeline.getTextReaderLoads()).toBe(0);

    const skippedPipeline = makeArchivePipeline();
    const skipped = await skippedPipeline.extract(archive, { children: 'skip' });
    expect(skipped.children).toEqual([]);
    expect(skippedPipeline.getTextReaderLoads()).toBe(0);
  });

  it('fails malformed header sizes and truncates when bounded PAX metadata exceeds output limits', async () => {
    const pipeline = makeArchivePipeline();
    await expect(pipeline.extract(archiveFixture('tar-size-lie.tar'))).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    await expect(pipeline.extract(archiveFixture('tar-pax-size-lie.tar'))).rejects.toBeInstanceOf(
      CorruptFileError,
    );

    const limited = await pipeline.extract(archiveFixture('tar-pax-long-path.tar'), {
      limits: { outputChars: 1 },
    });
    expect(limited.stats.truncated).toBe(true);
    expect(limited.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(limited.children).toEqual([]);
  });

  it('shares output limits across extracted children and stops after truncation', async () => {
    const pipeline = makeArchivePipeline();
    const document = await pipeline.extract(
      makeTar([
        { name: 'first.txt', data: text('first') },
        { name: 'second.txt', data: text('second') },
      ]),
      { limits: { outputChars: 8 } },
    );

    expect(document.stats.truncated).toBe(true);
    expect(document.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    expect(document.children).toHaveLength(2);
    expect(document.children[0]?.document?.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'first' });
    expect(document.children[1]?.document?.blocks).toEqual([]);
    expect(document.children[1]?.document?.stats.truncated).toBe(true);
  });

  it('returns a child failure for a damaged GZIP member embedded in TAR', async () => {
    const damagedGzip = gzipSync(text('damaged nested child'));
    damagedGzip[damagedGzip.length - 8] = damagedGzip[damagedGzip.length - 8]! ^ 0xff;
    const pipeline = makeArchivePipeline();
    const document = await pipeline.extract(
      makeTar([
        { name: 'broken.txt.gz', data: damagedGzip },
        { name: 'good.txt', data: text('still parsed') },
      ]),
    );
    expect(document.children.map(({ status }) => status)).toEqual(['failed', 'extracted']);
    expect(document.children[0]?.error?.code).toBe('CORRUPT_FILE');
    expect(document.children[1]?.document?.blocks[0]).toMatchObject({
      kind: 'paragraph',
      text: 'still parsed',
    });
  });
});

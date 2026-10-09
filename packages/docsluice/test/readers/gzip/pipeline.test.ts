import { describe, expect, it } from 'vitest';
import { gzipSync } from 'fflate';
import { CorruptFileError, LimitExceededError } from '../../../src/core/errors.js';
import { archiveFixture, makeArchivePipeline, makeTar } from '../tar/pipeline-support.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('GZIP extraction pipeline', () => {
  it('detects GZIP bytes and re-detects the child instead of inheriting a forced parent format', async () => {
    const pipeline = makeArchivePipeline();
    const payload = text('This is a plain child document.');
    const document = await pipeline.extract(gzipSync(payload), {
      filename: 'payload.txt.gz',
      childBytes: true,
    });

    expect(document.format).toBe('gzip');
    expect(document.children).toHaveLength(1);
    expect(document.children[0]).toMatchObject({
      path: 'payload.txt',
      name: 'payload.txt',
      status: 'extracted',
      bytes: payload,
      document: { format: 'txt', blocks: [{ kind: 'paragraph', text: 'This is a plain child document.' }] },
    });
    expect(pipeline.getTextReaderLoads()).toBe(1);

    const forcedPipeline = makeArchivePipeline();
    const forced = await forcedPipeline.extract(gzipSync(payload), {
      filename: 'forced.txt.gz',
      format: 'gzip',
    });
    expect(forced.format).toBe('gzip');
    expect(forced.children[0]?.document?.format).toBe('txt');
  });

  it('routes a prepared tar.gz through gzip then tar with nested child paths', async () => {
    const pipeline = makeArchivePipeline();
    const archive = archiveFixture('tar-gzip.tar.gz');
    const document = await pipeline.extract(archive, {
      filename: 'bundle.tar.gz',
      childBytes: true,
    });

    expect(document.format).toBe('gzip');
    expect(document.children).toHaveLength(1);
    const tarChild = document.children[0]!;
    expect(tarChild).toMatchObject({ path: 'bundle.tar', status: 'extracted', document: { format: 'tar' } });
    expect(tarChild.bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(tarChild.bytes).slice(257, 262)).toBe('ustar');
    const csvChild = tarChild.document!.children.find((child) => child.name.endsWith('data.csv'))!;
    expect(csvChild.path).toBe('bundle.tar/folder/subfolder/data.csv');
    expect(csvChild.document?.format).toBe('csv');
    expect(csvChild.document?.blocks[0]?.kind).toBe('paragraph');
    expect(csvChild.document?.blocks[0]?.loc.path).toBe('bundle.tar/folder/subfolder/data.csv');
    expect(pipeline.getCsvReaderLoads()).toBe(1);
  });

  it('passes the shared byte allowance through the decompressed TAR child', async () => {
    const pipeline = makeArchivePipeline();
    const payload = text('nested payload bytes');
    const tar = makeTar([{ name: 'nested/payload.txt', data: payload }]);
    const document = await pipeline.extract(gzipSync(tar), {
      filename: 'bytes.tar.gz',
      limits: { totalUncompressedBytes: tar.length },
    });

    expect(document.stats.truncated).toBe(true);
    expect(document.warnings.map(({ code }) => code)).toContain('TRUNCATED');
    const tarChild = document.children[0]!;
    expect(tarChild.document?.stats.truncated).toBe(true);
    expect(tarChild.document?.children).toEqual([]);
    expect(pipeline.getTextReaderLoads()).toBe(0);
  });

  it('lists a GZIP child without inflating or checking its damaged payload trailer', async () => {
    const pipeline = makeArchivePipeline();
    const corrupted = gzipSync(text('not inflated in list mode'));
    corrupted[corrupted.length - 8] = corrupted[corrupted.length - 8]! ^ 0xff;
    const document = await pipeline.extract(corrupted, {
      filename: 'listed.txt.gz',
      children: 'list',
    });

    expect(document.children).toHaveLength(1);
    expect(document.children[0]).toMatchObject({ path: 'listed.txt', status: 'listed' });
    expect(document.children[0]?.document).toBeUndefined();
    expect(pipeline.getTextReaderLoads()).toBe(0);
    expect(pipeline.getCsvReaderLoads()).toBe(0);
  });

  it('skips GZIP child work in skip mode', async () => {
    const pipeline = makeArchivePipeline();
    const document = await pipeline.extract(gzipSync(text('not opened')), {
      filename: 'skipped.txt.gz',
      children: 'skip',
    });
    expect(document.children).toEqual([]);
    expect(pipeline.getTextReaderLoads()).toBe(0);
  });

  it('rejects a bad member CRC and propagates the hard shared-byte limit', async () => {
    const pipeline = makeArchivePipeline();
    const corrupted = gzipSync(text('bad crc'));
    corrupted[corrupted.length - 8] = corrupted[corrupted.length - 8]! ^ 0xff;
    await expect(pipeline.extract(corrupted, { filename: 'bad.txt.gz' })).rejects.toBeInstanceOf(
      CorruptFileError,
    );
    await expect(
      pipeline.extract(archiveFixture('gzip-bounded-amplification.gz'), {
        filename: 'amplified.txt.gz',
        onLimit: 'throw',
        limits: { totalUncompressedBytes: 64 },
      }),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });

  it('lists a TAR child when nested depth is exhausted before opening it', async () => {
    const pipeline = makeArchivePipeline();
    const document = await pipeline.extract(archiveFixture('tar-gzip.tar.gz'), {
      filename: 'deep.tar.gz',
      limits: { childDepth: 1 },
    });
    const tarChild = document.children[0]!;
    expect(tarChild.status).toBe('extracted');
    expect(tarChild.document?.children.some((child) => child.status === 'listed')).toBe(true);
    expect(document.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
    expect(pipeline.getCsvReaderLoads()).toBe(0);
  });
});

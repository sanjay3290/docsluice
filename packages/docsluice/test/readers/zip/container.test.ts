import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { AbortError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import type { ResolvedOptions } from '../../../src/core/options.js';
import type { ChildDocument } from '../../../src/core/model.js';
import { makeZip } from '../../helpers/zip.js';
import { openZip, type ZipArchive } from '../../../src/zip/index.js';
import { zipReader } from '../../../src/readers/zip/index.js';

function context(
  bytes: Uint8Array,
  children: 'extract' | 'list' | 'skip' = 'extract',
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  path = '',
  zipOverride?: ZipArchive,
  signal?: AbortSignal,
) {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...limits }, { signal });
  const options: ResolvedOptions = {
    children,
    limits: budget.limits,
    onLimit: 'truncate',
    strict: false,
    metadata: true,
    childBytes: false,
    runs: false,
    revisions: 'accept',
    includeHidden: false,
    formulas: false,
  };
  const out = new DocBuilder('zip', 'application/zip', budget, options);
  const delegated: string[] = [];
  const zip = zipOverride ?? openZip(bytes, budget);
  const ctx: ReadContext = {
    bytes,
    options,
    budget,
    warnings: budget.warnings,
    out,
    path,
    zip,
    extractChild(name: string, childBytes: Uint8Array) {
      delegated.push(name);
      const childPath = path === '' ? name : `${path}/${name}`;
      const child: ChildDocument = {
        path: childPath,
        name,
        status: 'extracted',
        sizeBytes: childBytes.length,
      };
      out.addChild(child);
      return Promise.resolve();
    },
  };
  return { ctx, budget, out, delegated, zip };
}

describe('zipReader', () => {
  it('delegates regular entries in central-directory order and lists skipped names safely', async () => {
    const bytes = makeZip([
      { name: 'first.txt', data: new TextEncoder().encode('first') },
      { name: '.DS_Store', data: new Uint8Array([1]) },
      { name: '__MACOSX/._file', data: new Uint8Array([2]) },
      { name: 'nested/__MACOSX/._file', data: new Uint8Array([2]) },
      { name: 'nested/.DS_Store', data: new Uint8Array([1]) },
      { name: 'nested/thumbs.DB', data: new Uint8Array([3]) },
      { name: 'folder/', data: new Uint8Array() },
      { name: '../../etc/passwd', data: new TextEncoder().encode('path-name only') },
      { name: 'Thumbs.db', data: new Uint8Array([3]) },
    ]);
    const { ctx, out, delegated } = context(bytes);

    await zipReader.read(ctx);

    expect(delegated).toEqual(['first.txt', 'etc/passwd']);
    expect(out.finish().children.map(({ path, name, status }) => [path, name, status])).toEqual([
      ['first.txt', 'first.txt', 'extracted'],
      ['.DS_Store', '.DS_Store', 'skipped'],
      ['__MACOSX/._file', '__MACOSX/._file', 'skipped'],
      ['nested/__MACOSX/._file', 'nested/__MACOSX/._file', 'skipped'],
      ['nested/.DS_Store', 'nested/.DS_Store', 'skipped'],
      ['nested/thumbs.DB', 'nested/thumbs.DB', 'skipped'],
      ['folder/', 'folder/', 'skipped'],
      ['etc/passwd', 'etc/passwd', 'extracted'],
      ['Thumbs.db', 'Thumbs.db', 'skipped'],
    ]);
  });

  it('reads the checked-in mixed ZIP candidate in its documented entry order', async () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('../../../../../corpus/zip/package-e-mixed.zip', import.meta.url)),
    );
    const fixture = context(bytes);

    await zipReader.read(fixture.ctx);

    expect(fixture.delegated).toEqual(['data.csv', 'page.html', 'nested/inside.zip', 'pixel.png']);
    expect(fixture.out.finish().children.map(({ name, status }) => [name, status])).toEqual([
      ['data.csv', 'extracted'],
      ['page.html', 'extracted'],
      ['nested/inside.zip', 'extracted'],
      ['pixel.png', 'extracted'],
      ['folder/', 'skipped'],
    ]);
  });

  it('lists children without reading entry payloads', async () => {
    const bytes = makeZip([
      { name: 'one.txt', data: new Uint8Array([1]) },
      { name: 'two.txt', data: new Uint8Array([2]) },
    ]);
    const fixture = context(bytes, 'list');
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);

    expect(read).not.toHaveBeenCalled();
    expect(fixture.delegated).toEqual([]);
    expect(fixture.out.finish().children.map(({ name, status }) => [name, status])).toEqual([
      ['one.txt', 'listed'],
      ['two.txt', 'listed'],
    ]);
  });

  it('prefixes directly listed children with their parent path', async () => {
    const bytes = makeZip([{ name: 'nested/report.csv', data: new Uint8Array([1]) }]);
    const fixture = context(bytes, 'list', {}, 'outer.zip');

    await zipReader.read(fixture.ctx);

    expect(fixture.out.finish().children[0]?.path).toBe('outer.zip/nested/report.csv');
  });

  it('omits regular children in skip mode without reading entry payloads', async () => {
    const bytes = makeZip([
      { name: 'one.txt', data: new Uint8Array([1]) },
      { name: 'folder/', data: new Uint8Array() },
    ]);
    const fixture = context(bytes, 'skip');
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);

    expect(read).not.toHaveBeenCalled();
    expect(fixture.out.finish().children.map(({ name, status }) => [name, status])).toEqual([
      ['folder/', 'skipped'],
    ]);
  });

  it('reports encrypted entries as failed and sets the encryption feature without reading payloads', async () => {
    const bytes = makeZip([
      { name: 'secret.docx', data: new Uint8Array([1, 2]), flags: 1 },
      { name: 'plain.txt', data: new Uint8Array([3]) },
    ]);
    const fixture = context(bytes, 'list');
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);
    const document = fixture.out.finish();

    expect(read).not.toHaveBeenCalled();
    expect(document.features.isEncrypted).toBe(true);
    expect(document.children.map(({ name, status, error }) => [name, status, error?.code])).toEqual([
      ['secret.docx', 'failed', 'ENCRYPTED'],
      ['plain.txt', 'listed', undefined],
    ]);
  });

  it('marks archive entries that cannot be read as failed without delegating them', async () => {
    const bytes = makeZip([{ name: 'unsupported.bin', data: new Uint8Array([1]), method: 12 }]);
    const fixture = context(bytes);
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);

    expect(read).not.toHaveBeenCalled();
    expect(fixture.delegated).toEqual([]);
    expect(fixture.out.finish().children.map(({ status, error }) => [status, error?.code])).toEqual([
      ['failed', 'UNREADABLE_PART'],
    ]);
  });

  it('lists over-depth children and leaves their payloads unread', async () => {
    const bytes = makeZip([{ name: 'nested.zip', data: new Uint8Array([1]) }]);
    const fixture = context(bytes, 'extract', { childDepth: 0 });
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);
    const document = fixture.out.finish();

    expect(read).not.toHaveBeenCalled();
    expect(document.children[0]?.status).toBe('listed');
    expect(document.warnings.map(({ code }) => code)).toContain('DEPTH_LIMIT');
  });

  it.each([
    ['empty archive', []],
    ['directory-only archive', [{ name: 'only/', data: new Uint8Array() }]],
  ] as const)('does not preflight child depth for an %s', async (_label, entries) => {
    const bytes = makeZip(entries);
    const fixture = context(bytes, 'extract', { childDepth: 0 });

    await expect(zipReader.read(fixture.ctx)).resolves.toBeUndefined();

    expect(fixture.out.finish().warnings.map(({ code }) => code)).not.toContain('DEPTH_LIMIT');
    expect(fixture.delegated).toEqual([]);
  });

  it('marks a byte-identical child as recursive without delegating it', async () => {
    const bytes = new Uint8Array([0x52, 0x45, 0x43, 0x55, 0x52, 0x53, 0x49, 0x56, 0x45]);
    const archive: ZipArchive = {
      entries: [
        {
          name: 'self.zip',
          compressedSize: bytes.length,
          uncompressedSize: bytes.length,
          compressionMethod: 0,
          isEncrypted: false,
          isUnreadable: false,
        },
      ],
      read() {
        return Promise.resolve(bytes.slice());
      },
    };
    const fixture = context(bytes, 'extract', {}, '', archive);

    await zipReader.read(fixture.ctx);

    expect(fixture.delegated).toEqual([]);
    expect(fixture.out.finish().children.map(({ status, error }) => [status, error?.code])).toEqual([
      ['failed', 'CORRUPT_FILE'],
    ]);
  });

  it('stops reading later payloads when the real shared byte budget truncates', async () => {
    const bytes = makeZip([
      { name: 'first.bin', data: new Uint8Array([1, 2, 3]) },
      { name: 'second.bin', data: new Uint8Array([4, 5, 6]) },
    ]);
    const fixture = context(bytes, 'extract', { totalUncompressedBytes: 1 });
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);
    const document = fixture.out.finish();

    expect(read).toHaveBeenCalledTimes(1);
    expect(fixture.budget.truncated).toBe(true);
    expect(document.children.map(({ name, status }) => [name, status])).toEqual([['first.bin', 'failed']]);
  });

  it('propagates a real AbortSignal cancellation before reading payload data', async () => {
    const controller = new AbortController();
    const bytes = makeZip([{ name: 'entry.bin', data: new Uint8Array([1]) }]);
    const fixture = context(bytes, 'extract', {}, '', undefined, controller.signal);
    const read = vi.spyOn(fixture.zip, 'read');
    controller.abort();

    await expect(zipReader.read(fixture.ctx)).rejects.toBeInstanceOf(AbortError);
    expect(read).not.toHaveBeenCalled();
  });

  it('propagates failures from nested child extraction', async () => {
    const bytes = makeZip([{ name: 'nested.zip', data: new Uint8Array([1]) }]);
    const fixture = context(bytes);
    const failure = new AbortError();
    vi.spyOn(fixture.ctx, 'extractChild').mockRejectedValue(failure);

    await expect(zipReader.read(fixture.ctx)).rejects.toBe(failure);
  });

  it('keeps list mode bounded at the configured 10,000-entry default', async () => {
    const bytes = makeZip(
      Array.from({ length: DEFAULT_LIMITS.zipEntries }, (_, index) => ({
        name: `entry-${index}.txt`,
        data: new Uint8Array(),
      })),
    );
    const fixture = context(bytes, 'list');
    const read = vi.spyOn(fixture.zip, 'read');

    await zipReader.read(fixture.ctx);

    expect(fixture.out.finish().children).toHaveLength(DEFAULT_LIMITS.zipEntries);
    expect(read).not.toHaveBeenCalled();
  });
});

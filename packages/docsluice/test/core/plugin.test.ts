import { strToU8, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  CorruptFileError,
  createRegistry,
  detect,
  extract,
  PluginContractError,
  READER_CONTRACT_VERSION,
  registerFormat,
} from '../../src/index.js';
import type { FormatPlugin, ReadContext } from '../../src/index.js';

const encode = (text: string) => new TextEncoder().encode(text);
const MAGIC = 'TALLY\n';

/** A made-up format: a `TALLY` line, then `item=count` lines, read into one table. */
function tally(overrides: Partial<FormatPlugin> = {}): FormatPlugin {
  return {
    id: 'tally',
    contract: READER_CONTRACT_VERSION,
    mimeTypes: ['application/x-tally'],
    extensions: ['tally'],
    detect: (bytes) => {
      for (let index = 0; index < MAGIC.length; index++)
        if (bytes[index] !== MAGIC.charCodeAt(index)) return 0;
      return 1;
    },
    read(ctx: ReadContext) {
      const text = new TextDecoder().decode(ctx.bytes);
      const rows = [[{ text: 'Item' }, { text: 'Count' }]];
      for (const line of text.split('\n').slice(1)) {
        ctx.budget.tick();
        const equals = line.indexOf('=');
        if (equals < 0) continue;
        if (!ctx.budget.addCells(2)) break;
        rows.push([{ text: line.slice(0, equals) }, { text: line.slice(equals + 1) }]);
      }
      ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});
      return Promise.resolve();
    },
    ...overrides,
  };
}

describe('format plugins (EXT-4, EXT-7)', () => {
  it('extracts a made-up format end to end through its own registry', async () => {
    const registry = createRegistry();
    registry.registerFormat(tally());
    const doc = await extract(encode(`${MAGIC}apples=3\npears=5`), { registry });
    expect(doc.format).toBe('tally');
    expect(doc.mimeType).toBe('application/x-tally');
    expect(doc.blocks).toMatchObject([
      {
        kind: 'table',
        headerRows: 1,
        rows: [
          [{ text: 'Item' }, { text: 'Count' }],
          [{ text: 'apples' }, { text: '3' }],
          [{ text: 'pears' }, { text: '5' }],
        ],
      },
    ]);
    expect((await detect(encode(`${MAGIC}a=1`), { registry })).format).toBe('tally');
  });

  it('does not change the default registry', async () => {
    const registry = createRegistry();
    registry.registerFormat(tally());
    const doc = await extract(encode(`${MAGIC}apples=3`));
    expect(doc.format).toBe('txt');
  });

  it('chooses a plugin by extension or MIME hint, or by forced format', async () => {
    const registry = createRegistry();
    registry.registerFormat(tally({ detect: undefined }));
    expect((await extract(encode('apples=3'), { registry, filename: 'fruit.TALLY' })).format).toBe('tally');
    expect((await extract(encode('apples=3'), { registry, mimeType: 'application/x-tally' })).format).toBe(
      'tally',
    );
    expect((await extract(encode('apples=3'), { registry, format: 'tally' })).format).toBe('tally');
    expect((await extract(encode('apples=3'), { registry })).format).toBe('txt');
  });

  it('runs plugin probes only when built-in detection is not confident', async () => {
    const probe = vi.fn(() => 1);
    const registry = createRegistry();
    registry.registerFormat(tally({ detect: probe }));
    const zip = zipSync({ 'a.txt': [strToU8('hello'), { mtime: new Date('1980-01-01T00:00:00Z') }] });
    expect((await extract(zip, { registry, children: 'skip' })).format).toBe('zip');
    expect(probe).not.toHaveBeenCalled();
    expect((await extract(encode('{"json": true}'), { registry })).format).toBe('json');
    expect(probe).not.toHaveBeenCalled();
    expect((await extract(encode('plain words'), { registry })).format).toBe('tally');
    expect(probe).toHaveBeenCalled();
  });

  it('treats a probe that throws as no match', async () => {
    const registry = createRegistry();
    registry.registerFormat(
      tally({
        detect: () => {
          throw new Error('probe bug');
        },
      }),
    );
    expect((await extract(encode('plain words'), { registry })).format).toBe('txt');
  });

  it('reads plugin formats inside archives with the same registry and shared budget', async () => {
    const registry = createRegistry();
    registry.registerFormat(tally());
    const zip = zipSync({
      'counts.tally': [strToU8(`${MAGIC}a=1\nb=2\nc=3`), { mtime: new Date('1980-01-01T00:00:00Z') }],
    });
    const doc = await extract(zip, { registry, limits: { cells: 3 } });
    const child = doc.children[0]!;
    expect(child).toMatchObject({
      path: 'counts.tally',
      status: 'extracted',
      mimeType: 'application/x-tally',
    });
    expect(child.document!.format).toBe('tally');
    // The child shares the parent's cell allowance: only the first data row fits.
    const table = child.document!.blocks[0] as { rows: unknown[] };
    expect(table.rows).toHaveLength(2);
    expect(doc.stats.truncated).toBe(true);
  });

  it('refuses a plugin built for another contract major with a clear error', () => {
    const registry = createRegistry();
    let error: unknown;
    try {
      registry.registerFormat(tally({ contract: '2.0.0' }));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PluginContractError);
    expect(error).toMatchObject({
      code: 'PLUGIN_INCOMPATIBLE',
      plugin: 'tally',
      contract: '2.0.0',
      message: 'Format plugin "tally" needs reader contract 2.0.0; this docsluice provides 1.0.0.',
    });
    expect(() => registry.registerFormat(tally({ contract: '1.9.0' }))).toThrow(PluginContractError);
    expect(() => registry.registerFormat(tally({ contract: 'latest' }))).toThrow(PluginContractError);
    expect(() => registry.registerFormat(tally({ contract: '1.0.7' }))).not.toThrow();
    expect(registry.plugins.map((plugin) => plugin.id)).toEqual(['tally']);
  });

  it('refuses built-in and duplicate ids', () => {
    const registry = createRegistry();
    expect(() => registry.registerFormat(tally({ id: 'docx' }))).toThrow(TypeError);
    registry.registerFormat(tally());
    expect(() => registry.registerFormat(tally())).toThrow(TypeError);
  });

  it('turns an exception inside read into CorruptFileError with the cause', async () => {
    const registry = createRegistry();
    const bug = new Error('plugin bug');
    registry.registerFormat(
      tally({
        read: () => Promise.reject(bug),
      }),
    );
    const failure = extract(encode(`${MAGIC}a=1`), { registry });
    await expect(failure).rejects.toBeInstanceOf(CorruptFileError);
    await expect(failure).rejects.toMatchObject({ code: 'CORRUPT_FILE', cause: bug });
  });

  it('registers on the default registry as a convenience', async () => {
    registerFormat(tally({ id: 'tally-default', extensions: ['tallyd'], detect: undefined }));
    expect((await extract(encode('a=1'), { filename: 'x.tallyd' })).format).toBe('tally-default');
  });
});

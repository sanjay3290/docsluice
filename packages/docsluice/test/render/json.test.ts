import { describe, expect, it, vi } from 'vitest';
import type { DocsluiceDocument } from '../../src/core/model.js';
import { toJSON } from '../../src/render/json.js';

function document(overrides: Partial<DocsluiceDocument> = {}): DocsluiceDocument {
  return {
    format: 'txt',
    mimeType: 'text/plain',
    metadata: {},
    features: {
      hasMacros: false,
      hasExternalLinks: false,
      hasEmbeddedFiles: false,
      isEncrypted: false,
      hasJavaScript: false,
    },
    blocks: [],
    children: [],
    warnings: [],
    stats: { bytesRead: 0, durationMs: 12, truncated: false, needsOcr: false },
    ...overrides,
  };
}

describe('toJSON', () => {
  it('uses model field order regardless of source insertion order and omits undefined values', () => {
    const first = document({
      stats: { needsOcr: false, truncated: false, durationMs: 12, bytesRead: 4 },
      metadata: { language: undefined, modified: 'yesterday', title: 'Title' },
      blocks: [{ loc: { path: 'p', page: 2 }, text: 'hello', kind: 'paragraph', runs: undefined }],
    });
    const second = document({
      stats: { bytesRead: 4, durationMs: 12, truncated: false, needsOcr: false },
      metadata: { title: 'Title', modified: 'yesterday', language: undefined },
      blocks: [{ kind: 'paragraph', runs: undefined, text: 'hello', loc: { page: 2, path: 'p' } }],
    });

    expect(toJSON(first)).toBe(toJSON(second));
    expect(toJSON(first)).toBe(
      '{"format":"txt","mimeType":"text/plain","metadata":{"title":"Title","modified":"yesterday"},"features":{"hasMacros":false,"hasExternalLinks":false,"hasEmbeddedFiles":false,"isEncrypted":false,"hasJavaScript":false},"blocks":[{"kind":"paragraph","text":"hello","loc":{"page":2,"path":"p"}}],"children":[],"warnings":[],"stats":{"bytesRead":4,"durationMs":12,"truncated":false,"needsOcr":false}}',
    );
  });

  it('round trips the document except undefined properties and child bytes by default', () => {
    const doc = document({
      encoding: undefined,
      metadata: { authors: ['Ada'], custom: [{ value: 'v', name: '__proto__' }] },
      children: [
        {
          path: 'a.bin',
          name: 'a.bin',
          status: 'extracted',
          bytes: new Uint8Array([0, 1, 2]),
          document: document({ blocks: [{ kind: 'heading', level: 1, text: 'Nested', loc: {} }] }),
        },
      ],
      warnings: [{ code: 'HIDDEN_CONTENT', message: 'Found', loc: { offset: [1, 3] } }],
    });

    const output = JSON.parse(toJSON(doc)) as unknown;
    expect(output).toEqual({
      format: 'txt',
      mimeType: 'text/plain',
      metadata: { authors: ['Ada'], custom: [{ name: '__proto__', value: 'v' }] },
      features: doc.features,
      blocks: [],
      children: [
        {
          path: 'a.bin',
          name: 'a.bin',
          status: 'extracted',
          document: {
            format: 'txt',
            mimeType: 'text/plain',
            metadata: {},
            features: doc.features,
            blocks: [{ kind: 'heading', level: 1, text: 'Nested', loc: {} }],
            children: [],
            warnings: [],
            stats: { bytesRead: 0, durationMs: 12, truncated: false, needsOcr: false },
          },
        },
      ],
      warnings: [{ code: 'HIDDEN_CONTENT', message: 'Found', loc: { offset: [1, 3] } }],
      stats: doc.stats,
    });
    expect(doc.children[0]?.bytes).toEqual(new Uint8Array([0, 1, 2]));
  });

  it('sets durationMs to zero in stable mode without mutating the document', () => {
    const doc = document();
    const before = structuredClone(doc);

    const output = JSON.parse(toJSON(doc, { stable: true })) as { stats: { durationMs: number } };
    expect(output.stats.durationMs).toBe(0);
    expect(doc).toEqual(before);
    expect(toJSON(doc, { stable: true })).toBe(toJSON(doc, { stable: true }));
  });

  it('encodes bytes as portable base64 when requested, including nested child bytes', () => {
    const doc = document({
      children: [{ path: 'x', name: 'x', status: 'listed', bytes: new Uint8Array([0, 1, 2, 253, 254, 255]) }],
    });
    const output = JSON.parse(toJSON(doc, { bytes: 'base64' })) as {
      children: Array<{ bytes?: string }>;
    };
    expect(output.children[0]?.bytes).toBe('AAEC/f7/');
  });

  it('matches JSON.stringify indentation semantics', () => {
    const doc = document({ encoding: 'utf-8' });
    const compact = JSON.parse(toJSON(doc)) as unknown;
    expect(toJSON(doc, { space: 2 })).toBe(JSON.stringify(compact, undefined, 2));
    expect(toJSON(doc, { space: '············' })).toBe(JSON.stringify(compact, undefined, '············'));
  });

  it('serializes deeply nested blocks and child documents without recursion', () => {
    let item: { text: string; items?: (typeof item)[] } = { text: 'leaf' };
    for (let i = 0; i < 63; i++) item = { text: String(i), items: [item] };
    let nested = document({ blocks: [{ kind: 'list', ordered: false, items: [item], loc: {} }] });
    for (let i = 0; i < 3; i++) {
      nested = document({
        children: [{ path: String(i), name: String(i), status: 'extracted', document: nested }],
      });
    }

    const output = toJSON(nested);
    expect(output.length).toBeGreaterThan(1_000);
    expect(output.startsWith('{"format":"txt"')).toBe(true);

    let section: DocsluiceDocument['blocks'][number] = { kind: 'paragraph', text: 'leaf', loc: {} };
    for (let i = 0; i < 64; i++) {
      section = { kind: 'section', role: 'part', blocks: [section], loc: {} };
    }
    expect(() => toJSON(document({ blocks: [section] }))).not.toThrow();
  });

  it('throws when the private block-depth or output-character cap is exceeded', () => {
    let item: { text: string; items?: (typeof item)[] } = { text: 'leaf' };
    for (let i = 0; i < 64; i++) item = { text: String(i), items: [item] };
    const tooDeep = document({ blocks: [{ kind: 'list', ordered: false, items: [item], loc: {} }] });
    expect(() => toJSON(tooDeep)).toThrowError('Limit "blockDepth" (64) was exceeded.');

    let child = document();
    for (let i = 0; i < 4; i++) {
      child = document({
        children: [{ path: String(i), name: String(i), status: 'extracted', document: child }],
      });
    }
    expect(() => toJSON(child)).toThrowError('Limit "childDepth" (3) was exceeded.');

    const tooLarge = document({ blocks: [{ kind: 'paragraph', text: 'x'.repeat(20_000_001), loc: {} }] });
    expect(() => toJSON(tooLarge)).toThrowError('Limit "outputChars" (20000000) was exceeded.');
  });

  it('accepts multiple string values whose combined output is below the character cap', () => {
    const text = 'x'.repeat(7_000_000);
    const doc = document({
      blocks: [
        { kind: 'paragraph', text, loc: {} },
        { kind: 'paragraph', text, loc: {} },
      ],
    });
    const output = toJSON(doc);
    expect(output.length).toBeGreaterThan(14_000_000);
    expect(output.length).toBeLessThan(20_000_000);
  });
  it('preflights oversized escaped strings before calling whole-string stringify', () => {
    const text = '\0'.repeat(3_500_000);
    const doc = document({ blocks: [{ kind: 'paragraph', text, loc: {} }] });
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      expect(() => toJSON(doc)).toThrowError('Limit "outputChars" (20000000) was exceeded.');
      expect(stringify.mock.calls.some(([value]) => value === text)).toBe(false);
    } finally {
      stringify.mockRestore();
    }
  });

  it('uses JSON-compatible escaping for controls and surrogate pairs', () => {
    const text = 'quotes: " \\ controls: \0\b\t\n\f\r separators: \u2028\u2029 lone: \ud800 pair: 😀';
    const doc = document({ blocks: [{ kind: 'paragraph', text, loc: {} }] });
    expect(toJSON(doc)).toContain(JSON.stringify(text));
    expect((JSON.parse(toJSON(doc)) as { blocks: Array<{ text: string }> }).blocks[0]?.text).toBe(text);
  });

  it('preflights oversized base64 before allocating its encoded output', () => {
    const doc = document({
      children: [
        { path: 'large.bin', name: 'large.bin', status: 'listed', bytes: new Uint8Array(15_000_000) },
      ],
    });
    const clock = vi.spyOn(performance, 'now');
    let error: unknown;
    try {
      toJSON(doc, { bytes: 'base64' });
    } catch (caught) {
      error = caught;
    }
    const callsBeforeRestore = clock.mock.calls.length;
    clock.mockRestore();
    expect(error).toMatchObject({ message: 'Limit "outputChars" (20000000) was exceeded.' });
    expect(callsBeforeRestore).toBeLessThan(5);
  });

  it('accepts a near-cap base64 payload after earlier output without double charging', () => {
    const doc = document({
      blocks: [{ kind: 'paragraph', text: 'x'.repeat(5_000_000), loc: {} }],
      children: [
        { path: 'near-cap.bin', name: 'near-cap.bin', status: 'listed', bytes: new Uint8Array(9_000_000) },
      ],
    });
    const output = toJSON(doc, { bytes: 'base64' });
    expect(output.length).toBeGreaterThan(16_000_000);
    expect(output.length).toBeLessThan(20_000_000);
  });

  it('allows a listed child at the deepest retained document level', () => {
    let nested = document({
      children: [{ path: 'leaf', name: 'leaf.bin', status: 'listed' }],
    });
    for (let i = 0; i < 3; i++) {
      nested = document({
        children: [{ path: String(i), name: String(i), status: 'extracted', document: nested }],
      });
    }
    let parsed = JSON.parse(toJSON(nested)) as {
      children: Array<{ document?: unknown; path?: string }>;
    };
    for (let i = 0; i < 3; i++) {
      parsed = parsed.children[0]?.document as typeof parsed;
    }
    expect(parsed.children[0]?.path).toBe('leaf');
  });

  it('rejects cycles but allows shared acyclic nested objects', () => {
    const custom: { name: string; value: unknown } = { name: 'cyclic', value: '' };
    custom.value = custom;
    const cyclic = document({ metadata: { custom: [custom as { name: string; value: string }] } });
    const start = performance.now();
    let clockCall = 0;
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
      clockCall++;
      return clockCall === 1 ? start : clockCall === 2 ? start + 1 : start + 61_000;
    });
    try {
      expect(() => toJSON(cyclic)).toThrowError(TypeError);
    } finally {
      clock.mockRestore();
    }

    const sharedLoc = { page: 1 };
    const shared = document({
      warnings: [
        { code: 'HIDDEN_CONTENT', message: 'one', loc: sharedLoc },
        { code: 'HIDDEN_CONTENT', message: 'two', loc: sharedLoc },
      ],
    });
    expect((JSON.parse(toJSON(shared)) as { warnings: unknown[] }).warnings).toHaveLength(2);
  });

  it('keeps every block and nested model field in its declared order', () => {
    const doc = document({
      metadata: {
        custom: [{ value: 'custom', name: 'custom' }],
        language: 'en',
        pageCount: 2,
        modified: 'm',
        created: 'c',
        authors: ['Ada'],
        title: 'Title',
      },
      blocks: [
        { loc: {}, text: 'heading', level: 2, kind: 'heading' },
        {
          loc: {},
          runs: [{ href: '/', code: true, italic: true, bold: true, text: 'r' }],
          text: 'paragraph',
          kind: 'paragraph',
        },
        {
          loc: {},
          items: [{ items: [{ marker: 'a)', text: 'nested' }], marker: '1.', text: 'item' }],
          ordered: true,
          kind: 'list',
        },
        {
          loc: {},
          caption: 'caption',
          headerRows: 1,
          rows: [
            [{ hidden: true, address: 'A1', colSpan: 2, rowSpan: 3, formula: '=1', raw: 1, text: 'cell' }],
          ],
          kind: 'table',
        },
        { loc: {}, text: 'code', language: 'ts', kind: 'code' },
        { loc: {}, height: 2, width: 1, ref: 'child', mimeType: 'image/png', alt: 'alt', kind: 'image' },
        { loc: {}, author: 'author', text: 'note', role: 'comment', kind: 'note' },
        { loc: {}, text: 'header', kind: 'header' },
        { loc: {}, text: 'footer', kind: 'footer' },
        {
          loc: {},
          blocks: [{ kind: 'paragraph', text: 'inside', loc: {} }],
          needsOcr: true,
          hidden: 'very',
          title: 'section',
          role: 'sheet',
          kind: 'section',
        },
      ],
      children: [
        {
          error: { message: 'failure', code: 'UNREADABLE_PART' },
          mimeType: 'application/octet-stream',
          sizeBytes: 2,
          status: 'failed',
          name: 'bad',
          path: 'bad',
        },
      ],
      warnings: [{ loc: { offset: [1, 2], path: 'p' }, message: 'warning', code: 'HIDDEN_CONTENT' }],
    });

    const output = JSON.parse(toJSON(doc)) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual([
      'format',
      'mimeType',
      'metadata',
      'features',
      'blocks',
      'children',
      'warnings',
      'stats',
    ]);
    expect(Object.keys(output.metadata as object)).toEqual([
      'title',
      'authors',
      'created',
      'modified',
      'pageCount',
      'language',
      'custom',
    ]);
    expect((output.blocks as Array<Record<string, unknown>>).map(Object.keys)).toEqual([
      ['kind', 'level', 'text', 'loc'],
      ['kind', 'text', 'runs', 'loc'],
      ['kind', 'ordered', 'items', 'loc'],
      ['kind', 'rows', 'headerRows', 'caption', 'loc'],
      ['kind', 'language', 'text', 'loc'],
      ['kind', 'alt', 'mimeType', 'ref', 'width', 'height', 'loc'],
      ['kind', 'role', 'text', 'author', 'loc'],
      ['kind', 'text', 'loc'],
      ['kind', 'text', 'loc'],
      ['kind', 'role', 'title', 'hidden', 'needsOcr', 'blocks', 'loc'],
    ]);
    const blocks = output.blocks as Array<Record<string, unknown>>;
    expect(Object.keys(blocks[1]!.runs instanceof Array ? (blocks[1]!.runs[0] as object) : {})).toEqual([
      'text',
      'bold',
      'italic',
      'code',
      'href',
    ]);
    expect(
      Object.keys(((blocks[2]!.items as Array<Record<string, unknown>>)[0]!.items as object[])[0]!),
    ).toEqual(['text', 'marker']);
    expect(Object.keys((blocks[3]!.rows as Array<Array<object>>)[0]![0]!)).toEqual([
      'text',
      'raw',
      'formula',
      'rowSpan',
      'colSpan',
      'address',
      'hidden',
    ]);
    expect(Object.keys(blocks[0]!.loc as object)).toEqual([]);
    expect(Object.keys((output.children as Array<Record<string, unknown>>)[0]!.error as object)).toEqual([
      'code',
      'message',
    ]);
    expect(Object.keys((output.warnings as Array<Record<string, unknown>>)[0]!.loc as object)).toEqual([
      'path',
      'offset',
    ]);
  });
});

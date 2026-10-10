import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Budget } from '../../../src/core/budget.js';
import { DocBuilder } from '../../../src/core/builder.js';
import { CorruptFileError, LimitExceededError } from '../../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../../src/core/limits.js';
import type { ReadContext } from '../../../src/core/reader.js';
import { WarningSink } from '../../../src/core/warnings.js';
import { tarReader as reader } from '../../../src/readers/tar/index.js';

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`../../../../../${name}`, import.meta.url)));
}

function makeContext(
  bytes: Uint8Array,
  overrides: Partial<typeof DEFAULT_LIMITS> = {},
  children: 'extract' | 'list' | 'skip' = 'extract',
  onLimit: 'truncate' | 'throw' = 'throw',
) {
  const budget = new Budget({ ...DEFAULT_LIMITS, ...overrides }, { onLimit });
  const warnings = new WarningSink();
  const options = { children, childBytes: false, metadata: true, runs: false } as ReadContext['options'];
  const out = new DocBuilder('tar', 'application/x-tar', budget, options);
  const extracted: Array<{ name: string; bytes: Uint8Array }> = [];
  const ctx: ReadContext = {
    bytes,
    options,
    budget,
    warnings,
    out,
    path: '',
    extractChild(name, childBytes) {
      extracted.push({ name, bytes: childBytes });
      return Promise.resolve();
    },
  };
  return { ctx, out, budget, extracted };
}

interface TarPart {
  name: string;
  data?: Uint8Array;
  type?: number;
  prefix?: string;
  declaredSize?: number;
  base256?: boolean;
}

function makeTar(parts: TarPart[], terminator = true): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    const data = part.data ?? new Uint8Array();
    const header = new Uint8Array(512);
    const put = (offset: number, length: number, value: string): void => {
      header.set(new TextEncoder().encode(value).subarray(0, length), offset);
    };
    const octal = (offset: number, length: number, value: number): void => {
      put(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    };
    put(0, 100, part.name);
    octal(100, 8, 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    if (part.base256) {
      let value = part.declaredSize ?? data.length;
      for (let index = 135; index >= 124; index--) {
        header[index] = value & 0xff;
        value = Math.floor(value / 256);
      }
      header[124] = header[124]! | 0x80;
    } else {
      octal(124, 12, part.declaredSize ?? data.length);
    }
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = part.type ?? 0x30;
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    put(345, 155, part.prefix ?? '');
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(new Uint8Array(padding));
  }
  if (terminator) chunks.push(new Uint8Array(1024));
  const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
  let cursor = 0;
  for (const chunk of chunks) {
    result.set(chunk, cursor);
    cursor += chunk.length;
  }
  return result;
}

function pax(key: string, value: string): Uint8Array {
  const suffix = `${key}=${value}\n`;
  let length = suffix.length + 2;
  while (`${length} `.length + suffix.length !== length) length = `${length} `.length + suffix.length;
  return new TextEncoder().encode(`${length} ${suffix}`);
}

describe('tar reader', () => {
  it('detects ustar headers and declines unknown bytes', () => {
    expect(reader.detect?.(fixture('corpus/tar/nested-folders.tar'))).toBe(0.9);
    expect(reader.detect?.(new Uint8Array(511))).toBe(0);
    expect(reader.detect?.(new Uint8Array(512))).toBe(0);
  });

  it('reads regular files in order and keeps safe normalized paths', async () => {
    const { ctx, out, extracted, budget } = makeContext(fixture('corpus/tar/nested-folders.tar'));
    await reader.read(ctx);
    expect(extracted.map((entry) => entry.name)).toEqual(['field/plots/counts.csv', 'field/notes.md']);
    expect(extracted.every((entry) => !entry.name.startsWith('/'))).toBe(true);
    expect(budget.totalUncompressedBytes).toBeGreaterThan(0);
    expect(out.finish().children.length).toBeGreaterThan(0);
  });

  it('applies PAX paths and GNU long names', async () => {
    for (const filename of ['corpus/tar/pax-long-path.tar', 'corpus/tar/gnu-long-name.tar']) {
      const { ctx, extracted } = makeContext(fixture(filename));
      await reader.read(ctx);
      expect(extracted).toHaveLength(1);
      expect(extracted[0]!.name.length).toBeGreaterThan(100);
    }
  });

  it('lists entries without reading file bodies', async () => {
    const { ctx, out, budget, extracted } = makeContext(fixture('corpus/tar/nested-folders.tar'), {}, 'list');
    await reader.read(ctx);
    expect(extracted).toEqual([]);
    expect(budget.totalUncompressedBytes).toBe(0);
    expect(out.finish().children.some((child) => child.status === 'listed')).toBe(true);
  });

  it('accepts a valid empty TAR and rejects a truncated trailing header', async () => {
    const empty = makeContext(new Uint8Array(1024));
    await reader.read(empty.ctx);
    expect(empty.out.finish().children).toEqual([]);
    await expect(reader.read(makeContext(new Uint8Array(13)).ctx)).rejects.toBeInstanceOf(CorruptFileError);
  });

  it('preflights child depth only for an extractable regular file', async () => {
    const { ctx, out, budget, extracted } = makeContext(fixture('corpus/tar/nested-folders.tar'), {
      childDepth: 0,
    });
    await reader.read(ctx);
    expect(extracted).toEqual([]);
    expect(out.finish().children.some((child) => child.status === 'listed')).toBe(true);
    expect(budget.warnings.warnings.some((warning) => warning.code === 'DEPTH_LIMIT')).toBe(true);
  });

  it('uses PAX path and size overrides and supports prefix and base-256 sizes', async () => {
    const bytes = makeTar([
      { name: 'PaxHeaders.0/x', type: 0x78, data: concat(pax('path', 'pax-result.csv'), pax('size', '3')) },
      { name: 'ignored', data: new TextEncoder().encode('abc'), declaredSize: 0 },
      { name: 'prefix.csv', prefix: 'dir', data: new TextEncoder().encode('x'), base256: true },
    ]);
    const { ctx, extracted } = makeContext(bytes);
    await reader.read(ctx);
    expect(extracted.map((entry) => entry.name)).toEqual(['pax-result.csv', 'dir/prefix.csv']);
    expect(extracted[0]!.bytes).toEqual(new TextEncoder().encode('abc'));
  });

  it('lists links, skips directories and special entries, and honors children=skip', async () => {
    const bytes = makeTar([
      { name: 'dir/', type: 0x35 },
      { name: 'link', type: 0x32, data: new TextEncoder().encode('target') },
      { name: 'device', type: 0x33 },
      { name: 'prefix-file', prefix: 'folder', data: new TextEncoder().encode('ok') },
    ]);
    const listed = makeContext(bytes, {}, 'list');
    await reader.read(listed.ctx);
    const children = listed.out.finish().children;
    expect(children.find((child) => child.name === 'link')?.status).toBe('listed');
    expect(children.find((child) => child.name === 'dir/')?.status).toBe('skipped');
    expect(children.find((child) => child.name === 'device')?.status).toBe('skipped');
    const skipped = makeContext(bytes, {}, 'skip');
    await reader.read(skipped.ctx);
    expect(skipped.extracted).toEqual([]);
    expect(skipped.out.finish().children).toEqual([]);
  });

  it('lists valid non-terminated entry headers and stops after child output truncation', async () => {
    const unterminated = makeTar([{ name: 'only.txt', data: new TextEncoder().encode('x') }], false);
    const listed = makeContext(unterminated, {}, 'list');
    await reader.read(listed.ctx);
    expect(listed.out.finish().children[0]?.name).toBe('only.txt');

    const twoFiles = makeTar([
      { name: 'one.txt', data: new TextEncoder().encode('one') },
      { name: 'two.txt', data: new TextEncoder().encode('two') },
    ]);
    const truncated = makeContext(twoFiles, { outputChars: 1 }, 'extract', 'truncate');
    let count = 0;
    const context: ReadContext = {
      ...truncated.ctx,
      async extractChild(name, bytes) {
        count++;
        truncated.budget.addOutputChars(2);
        await truncated.ctx.extractChild(name, bytes);
      },
    };
    await reader.read(context);
    expect(count).toBe(1);
  });

  it('detects malformed PAX records and truncated trailing headers', async () => {
    const paxBytes = makeTar([
      { name: 'PaxHeaders.0/x', type: 0x78, data: pax('path', 'bad') },
      { name: 'x', data: new TextEncoder().encode('x') },
    ]);
    const payloadStart = 512;
    paxBytes[payloadStart + pax('path', 'bad').length - 1] = 0x21;
    await expect(reader.read(makeContext(paxBytes).ctx)).rejects.toBeInstanceOf(CorruptFileError);
    const oneFile = makeTar([{ name: 'x', data: new TextEncoder().encode('x') }], false);
    const truncated = new Uint8Array(oneFile.length + 13);
    truncated.set(oneFile);
    // Damage after a readable entry keeps that entry, with a warning.
    const partial = makeContext(truncated);
    await reader.read(partial.ctx);
    expect(partial.extracted.map((entry) => entry.name)).toEqual(['x']);
    expect(partial.ctx.warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('rejects invalid checksum and size lies', async () => {
    await expect(
      reader.read(makeContext(fixture('hostile/tar/bad-checksum.tar')).ctx),
    ).rejects.toBeInstanceOf(CorruptFileError);
    await expect(reader.read(makeContext(fixture('hostile/tar/size-lie.tar')).ctx)).rejects.toBeInstanceOf(
      CorruptFileError,
    );
  });

  it('bounds PAX metadata claims and entry count', async () => {
    await expect(
      reader.read(makeContext(fixture('hostile/tar/pax-size-lie.tar')).ctx),
    ).rejects.toBeInstanceOf(CorruptFileError);
    await expect(
      reader.read(makeContext(fixture('corpus/tar/nested-folders.tar'), { zipEntries: 0 }).ctx),
    ).rejects.toBeInstanceOf(LimitExceededError);
  });
});

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Budget } from '../../src/core/budget.js';
import { CorruptFileError, LimitExceededError } from '../../src/core/errors.js';
import { DEFAULT_LIMITS } from '../../src/core/limits.js';
import { WarningSink } from '../../src/core/warnings.js';
import { parseXml, scanXml } from '../../src/xml/index.js';
import { openZip } from '../../src/zip/index.js';

const hostile = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../../../../hostile/package-a/${name}`, import.meta.url)));

type PrototypeSnapshot = Array<[PropertyKey, PropertyDescriptor]>;

function snapshot(target: object): PrototypeSnapshot {
  return Reflect.ownKeys(target).map((key) => [key, Object.getOwnPropertyDescriptor(target, key)!]);
}

function expectUnchanged(target: object, before: PrototypeSnapshot): void {
  const after = snapshot(target);
  expect(after.map(([key]) => key)).toEqual(before.map(([key]) => key));
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index]![1];
    const current = after[index]![1];
    expect(current).toEqual(prior);
  }
}

let objectPrototypeBefore: PrototypeSnapshot;
let arrayPrototypeBefore: PrototypeSnapshot;
let fetchBefore: PropertyDescriptor | undefined;
let fetchCalls = 0;

beforeEach(() => {
  objectPrototypeBefore = snapshot(Object.prototype);
  arrayPrototypeBefore = snapshot(Array.prototype);
  fetchBefore = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  fetchCalls = 0;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: () => {
      fetchCalls += 1;
      throw new Error('Unexpected network request from hostile parser');
    },
  });
});

afterEach(() => {
  try {
    expect(fetchCalls).toBe(0);
    expectUnchanged(Object.prototype, objectPrototypeBefore);
    expectUnchanged(Array.prototype, arrayPrototypeBefore);
  } finally {
    if (fetchBefore) Object.defineProperty(globalThis, 'fetch', fetchBefore);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
});

function context(options: ConstructorParameters<typeof Budget>[1] = {}) {
  const warnings = new WarningSink();
  const budget = new Budget(DEFAULT_LIMITS, { warnings, ...options });
  return { budget, warnings };
}

describe('package A hostile parser probes', () => {
  it.each(['xml/xxe-file.xml', 'xml/xxe-url.xml'])('does not resolve external XML entities in %s', (file) => {
    const { budget, warnings } = context();
    const texts: string[] = [];
    const opened: string[] = [];
    scanXml(hostile(file), { onOpen: (name) => opened.push(name), onText: (text) => texts.push(text) }, { budget, warnings });
    expect(opened).toContain('x');
    expect(texts.join('')).toBe('&e;')
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
  });

  it('ignores an external parameter entity and does not request its URL', () => {
    const { budget, warnings } = context();
    const texts: string[] = [];
    scanXml(hostile('xml/xxe-parameter.xml'), { onText: (text) => texts.push(text) }, { budget, warnings });
    expect(texts.join('')).toBe('local');
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED']);
  });

  it('keeps billion-laughs and quadratic entity references literal', () => {
    const cases: Array<[string, string]> = [
      ['xml/billion-laughs.xml', '&lol5;'],
      ['xml/quadratic-entities.xml', '&a;'.repeat(1_000)],
    ];
    for (const [file, expected] of cases) {
      const { budget, warnings } = context();
      const texts: string[] = [];
      scanXml(hostile(file), { onText: (text) => texts.push(text) }, { budget, warnings });
      expect(texts.join('')).toBe(expected);
      expect(warnings.warnings.map(({ code }) => code)).toEqual(['DTD_IGNORED', 'UNKNOWN_ENTITY']);
    }
  });

  it('bounds a 10,000-level XML tree at the default depth limit', () => {
    const { budget, warnings } = context();
    const root = parseXml(hostile('xml/deep-10000.xml'), { budget, warnings });
    expect(root).toBeDefined();
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
    let depth = 0;
    let node = root;
    while (node) {
      depth += 1;
      const child = node.children.find((item) => typeof item !== 'string');
      node = child === undefined || typeof child === 'string' ? undefined : child;
    }
    expect(depth).toBe(DEFAULT_LIMITS.xmlDepth);
  });

  it('retains prototype-shaped XML attribute names as Map keys', () => {
    const { budget, warnings } = context();
    const root = parseXml(hostile('xml/xml-proto-attributes.xml'), { budget, warnings });
    expect(root?.attrs.get('__proto__')).toBe('plain');
    expect(root?.attrs.get('constructor')).toBe('plain');
    expect(root?.attrs.get('prototype')).toBe('plain');
    const nested = root?.children.find((item) => typeof item !== 'string');
    expect(nested && typeof nested !== 'string' ? nested.attrs.get('__proto__') : undefined).toBe('also plain');
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('drops network-capable XML processing instructions', () => {
    const { budget, warnings } = context();
    const texts: string[] = [];
    scanXml(hostile('xml/xml-pi-network.xml'), { onText: (text) => texts.push(text) }, { budget, warnings });
    expect(texts.join('')).toBe('local');
    expect(warnings.warnings.map(({ code }) => code)).toEqual([]);
  });

  it('cleans traversal names while keeping ZIP entries display-only', () => {
    const { budget } = context();
    const archive = openZip(hostile('zip/zip-path-traversal.zip'), budget);
    expect(archive.entries.map(({ name }) => name)).toEqual(['etc/passwd']);
  });

  it('reads the finite nested-archive payload without recursively opening it', async () => {
    const { budget } = context();
    const outer = openZip(hostile('zip/zip-nested-high-ratio.zip'), budget);
    const innerBytes = await outer.read(outer.entries[0]!);
    expect(innerBytes?.[0]).toBe(0x50);
    expect(innerBytes?.[1]).toBe(0x4b);
  });

  it('follows the finite same-name ZIP chain for exactly eight layers', async () => {
    const { budget } = context();
    let bytes = hostile('zip/zip-quine-chain.zip');
    for (let depth = 0; depth < 8; depth += 1) {
      const archive = openZip(bytes, budget);
      expect(archive.entries.map(({ name }) => name)).toEqual(['loop.zip']);
      bytes = (await archive.read(archive.entries[0]!))!;
    }
    const leaf = openZip(bytes, budget);
    expect(leaf.entries.map(({ name }) => name)).toEqual(['payload.txt']);
  });

  it('stops indexing a ZIP with more entries than the default cap', () => {
    const { budget, warnings } = context();
    expect(openZip(hostile('zip/zip-many-entries.zip'), budget).entries).toEqual([]);
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('marks overlapping ZIP entries unreadable', () => {
    const { budget, warnings } = context();
    const archive = openZip(hostile('zip/zip-overlap.zip'), budget);
    expect(archive.entries.map(({ isUnreadable }) => isUnreadable)).toEqual([false, true]);
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['UNREADABLE_PART']);
  });

  it('rejects missing ZIP64 extra size values as corrupt', () => {
    const { budget } = context({ onLimit: 'throw' });
    expect(() => openZip(hostile('zip/zip64-size-lie.zip'), budget)).toThrow(CorruptFileError);
  });

  it('applies the ZIP entry cap before parsing a false ZIP64 million-entry count', () => {
    const warnings = new WarningSink();
    const budget = new Budget(DEFAULT_LIMITS, { warnings });
    expect(openZip(hostile('zip/zip64-count-lie.zip'), budget).entries).toEqual([]);
    expect(warnings.warnings.map(({ code }) => code)).toEqual(['TRUNCATED']);
  });

  it('rejects a truncated central directory as corrupt', () => {
    const { budget } = context({ onLimit: 'throw' });
    expect(() => openZip(hostile('zip/zip-truncated-central.zip'), budget)).toThrow(CorruptFileError);
  });

  it('bounds high-ratio ZIP output while streaming its entry', async () => {
    const { budget } = context({ onLimit: 'throw' });
    const archive = openZip(hostile('zip/zip-high-ratio.zip'), budget);
    await expect(archive.read(archive.entries[0]!)).rejects.toBeInstanceOf(LimitExceededError);
  });
});

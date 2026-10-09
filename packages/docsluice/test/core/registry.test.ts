import { expect, it, vi } from 'vitest';
import { ReaderRegistry } from '../../src/core/registry.js';
import type { Reader } from '../../src/core/reader.js';

const reader: Reader = { id: 'fake', mimeTypes: [], async read() {} };

it('refuses duplicate registrations without replacing the existing reader', async () => {
  const registry = new ReaderRegistry();
  const load = vi.fn(() => Promise.resolve(reader));
  registry.add({ id: 'fake', mimeTypes: [], load });
  expect(() => registry.add({ id: 'fake', mimeTypes: [], load })).toThrow(TypeError);
  expect(registry.load('unknown')).toBeUndefined();
  expect(await registry.load('fake')).toBe(reader);
  expect(load).toHaveBeenCalledTimes(1);
});

it('shares an in-flight reader import and retries a rejected import', async () => {
  const registry = new ReaderRegistry();
  const load = vi.fn().mockRejectedValueOnce(new Error('Import failed.')).mockResolvedValue(reader);
  registry.add({ id: 'fake', mimeTypes: [], load });
  const first = registry.load('fake')!;
  expect(registry.load('fake')).toBe(first);
  await expect(first).rejects.toThrow('Import failed.');
  expect(await registry.load('fake')).toBe(reader);
  expect(load).toHaveBeenCalledTimes(2);
});

it('rejects a reader without the required read method', async () => {
  const registry = new ReaderRegistry();
  registry.add({ id: 'fake', mimeTypes: [], load: () => Promise.resolve({} as Reader) });
  await expect(registry.load('fake')).rejects.toThrow('A reader must provide a read function.');
});

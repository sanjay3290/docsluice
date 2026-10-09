import { expect, it, vi } from 'vitest';
import { CorruptFileError, PluginContractError, extract, registerFormat } from '../../src/index.js';
import type { FormatPlugin } from '../../src/core/registry.js';
import { createRegistry } from '../../src/core/registry.js';
import { toText } from '../../src/render/text.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function markerPlugin(overrides: Partial<FormatPlugin> = {}): FormatPlugin {
  return {
    id: 'fixture',
    mimeTypes: ['application/x-fixture'],
    contract: '1.0.0',
    detect: (input) => (input[0] === 0xfa ? 0.95 : 0),
    read(ctx) {
      ctx.out.paragraph('fixture read');
      return Promise.resolve();
    },
    ...overrides,
  };
}

it('extracts a registered format through the public per-registry API', async () => {
  const registry = createRegistry();
  registry.registerFormat(markerPlugin());

  const document = await extract(bytes(0xfa, 0x01), { registry });

  expect(document).toMatchObject({ format: 'fixture', mimeType: 'application/x-fixture' });
  expect(toText(document)).toBe('fixture read');
});

it('supports explicit plugin formats without running detection and uses the plugin MIME type', async () => {
  const detect = vi.fn(() => 0);
  const registry = createRegistry();
  registry.registerFormat(markerPlugin({ detect }));

  const document = await extract(bytes(0x00), { registry, format: 'fixture' });

  expect(document).toMatchObject({ format: 'fixture', mimeType: 'application/x-fixture' });
  expect(detect).not.toHaveBeenCalled();
});

it('registers plugins on the default registry as a convenience', async () => {
  registerFormat(markerPlugin({ id: 'default-fixture' }));

  const document = await extract(bytes(0xfa, 0x01), { filename: 'file.default-fixture' });

  expect(document.format).toBe('default-fixture');
});

it('inherits lazy built-ins in each new registry without sharing plugin registrations', async () => {
  const first = createRegistry();
  first.registerFormat(markerPlugin());
  const second = createRegistry();

  expect(first.load('doc')).toBeDefined();
  expect(second.load('doc')).toBeDefined();
  await expect(extract(bytes(0xfa, 0x01), { registry: second })).rejects.toMatchObject({
    code: 'UNSUPPORTED_FORMAT',
  });
});

it('uses MIME and extension hints only while built-in detection is inconclusive', async () => {
  const detect = vi.fn((input: Uint8Array) => (input[0] === 0x41 ? 0.9 : 0));
  const registry = createRegistry();
  registry.registerFormat(markerPlugin({ detect }));

  const document = await extract(new TextEncoder().encode('A plain text payload'), {
    registry,
    filename: 'payload.fixture',
    mimeType: 'application/x-fixture',
  });

  expect(document.format).toBe('fixture');
  expect(detect).toHaveBeenCalledOnce();
});

it('reports tied confident plugin probes and keeps the uncertain built-in choice', async () => {
  const registry = createRegistry();
  registry.registerFormat(markerPlugin({ id: 'first', detect: () => 0.9 }));
  registry.registerFormat(markerPlugin({ id: 'second', detect: () => 0.9 }));
  registry.add({
    id: 'txt',
    mimeTypes: ['text/plain'],
    load: () =>
      Promise.resolve({
        id: 'txt',
        mimeTypes: ['text/plain'],
        read(ctx) {
          ctx.out.paragraph('built-in text');
          return Promise.resolve();
        },
      }),
  });

  const document = await extract(new TextEncoder().encode('ordinary text'), { registry });

  expect(document.format).toBe('txt');
  expect(toText(document)).toBe('built-in text');
  expect(document.warnings).toContainEqual(
    expect.objectContaining({
      code: 'FORMAT_MISMATCH',
      message: 'Multiple registered plugins matched uncertain content; no plugin was selected.',
    }),
  );
});

it('does not let matching plugin hints override confident built-in content detection', async () => {
  const detect = vi.fn(() => 1);
  const registry = createRegistry();
  registry.registerFormat(markerPlugin({ id: 'custom-json', detect }));
  registry.add({
    id: 'json',
    mimeTypes: ['application/json'],
    load: () =>
      Promise.resolve({
        id: 'json',
        mimeTypes: ['application/json'],
        read(ctx) {
          ctx.out.paragraph('built-in');
          return Promise.resolve();
        },
      }),
  });

  const document = await extract(new TextEncoder().encode('{"ok":true}'), {
    registry,
    filename: 'payload.custom-json',
    mimeType: 'application/x-fixture',
  });

  expect(document.format).toBe('json');
  expect(detect).not.toHaveBeenCalled();
  expect(document.warnings.map(({ code }) => code)).toContain('FORMAT_MISMATCH');
});

it('rejects incompatible reader contract majors with the stable plugin error', () => {
  const registry = createRegistry();

  expect(() => registry.registerFormat(markerPlugin({ contract: '2.0.0' }))).toThrow(PluginContractError);
  try {
    registry.registerFormat(markerPlugin({ contract: '2.0.0' }));
  } catch (error) {
    expect(error).toMatchObject({ code: 'PLUGIN_INCOMPATIBLE' });
  }
});

it('wraps plugin reader failures as content-safe corrupt-file errors and preserves cause', async () => {
  const failure = new Error('private document text');
  const registry = createRegistry();
  registry.registerFormat(
    markerPlugin({
      read() {
        return Promise.reject(failure);
      },
    }),
  );

  await expect(extract(bytes(0xfa, 0x01), { registry })).rejects.toSatisfy((error: unknown) => {
    return (
      error instanceof CorruptFileError &&
      error.cause === failure &&
      !error.message.includes('private document text')
    );
  });
});

it('rejects malformed plugin descriptors without quoting plugin-supplied values', () => {
  const registry = createRegistry();

  let error: unknown;
  try {
    registry.registerFormat({ ...markerPlugin(), id: 'sensitive value' });
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ message: 'A format plugin must provide a valid format id.' });
  expect((error as Error).message).not.toContain('sensitive value');
});

it('rejects an invalid detection confidence with a generic error', async () => {
  const registry = createRegistry();
  registry.registerFormat(markerPlugin({ detect: () => Number.NaN }));

  await expect(extract(bytes(0xfa, 0x01), { registry })).rejects.toMatchObject({
    message: 'A format plugin detect function must return a confidence from zero to one.',
  });
});

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  collectPackagesWithInstallScripts,
  parseRuntimeAllowlist,
  validateRuntimeDependencies,
} from './check-deps.mjs';

// Resolve symlinks (macOS /var -> /private/var): the checker compares real paths.
async function makeTempRoot() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), 'docsluice-check-deps-')));
}

test('parses runtime packages from the ADR dependency table', () => {
  const allowlist = parseRuntimeAllowlist(`
## Decision

| Package | Why | ADR |
|---------|-----|-----|
| \`fflate\` | Pure-JS inflate with byte counting | 0005 |
| \`unpdf\` | PDF text layer | 0009 |
`);

  assert.deepEqual([...allowlist], ['fflate', 'unpdf']);
});

test('rejects dependencies that are missing from the ADR allow-list', () => {
  assert.throws(
    () =>
      validateRuntimeDependencies({
        dependencies: { fflate: '0.8.2', unpdf: '1.0.0', surprise: '1.2.3' },
        allowlist: new Set(['fflate', 'unpdf']),
      }),
    /surprise.*not listed/i,
  );
});

test('rejects unlisted optional dependencies', () => {
  assert.throws(
    () =>
      validateRuntimeDependencies({
        optionalDependencies: { surprise: '1.2.3' },
        allowlist: new Set(['fflate', 'unpdf']),
      }),
    /surprise.*not listed/i,
  );
});

test('validates nonoptional peers and rejects disagreeing dependency specs', () => {
  assert.throws(
    () =>
      validateRuntimeDependencies({
        dependencies: { fflate: '0.8.2' },
        peerDependencies: { fflate: '0.9.0', unpdf: '1.0.0', surprise: '1.2.3' },
        peerDependenciesMeta: { unpdf: { optional: true } },
        allowlist: new Set(['fflate', 'unpdf']),
      }),
    /fflate.*disagree/i,
  );
});

test('rejects nonoptional peer dependencies outside the ADR allow-list', () => {
  assert.throws(
    () =>
      validateRuntimeDependencies({
        peerDependencies: { surprise: '1.2.3' },
        allowlist: new Set(['fflate', 'unpdf']),
      }),
    /surprise.*not listed/i,
  );
});

test('ignores optional peers because npm does not install them by default', () => {
  assert.doesNotThrow(() =>
    validateRuntimeDependencies({
      peerDependencies: { optionalPlugin: '1.2.3' },
      peerDependenciesMeta: { optionalPlugin: { optional: true } },
      allowlist: new Set(['fflate', 'unpdf']),
    }),
  );
});

test('checks optional dependency and required peer lockfile specs and versions', () => {
  const args = {
    optionalDependencies: { fflate: '0.8.2' },
    peerDependencies: { unpdf: '1.0.0' },
    allowlist: new Set(['fflate', 'unpdf']),
    lockfile: {
      packages: {
        'packages/docsluice': {
          optionalDependencies: { fflate: '0.8.2' },
          peerDependencies: { unpdf: '1.0.0' },
        },
        'node_modules/fflate': { version: '0.8.2' },
        'node_modules/unpdf': { version: '1.0.0' },
      },
    },
  };

  assert.doesNotThrow(() => validateRuntimeDependencies(args));
  assert.throws(
    () =>
      validateRuntimeDependencies({
        ...args,
        lockfile: {
          ...args.lockfile,
          packages: {
            ...args.lockfile.packages,
            'packages/docsluice': {
              ...args.lockfile.packages['packages/docsluice'],
              optionalDependencies: { fflate: '0.8.3' },
            },
          },
        },
      }),
    /fflate package-lock optionalDependencies spec 0.8.3 does not match 0.8.2/i,
  );
});

test('requires exact runtime versions rather than ranges', () => {
  assert.throws(
    () =>
      validateRuntimeDependencies({
        dependencies: { fflate: '^0.8.2' },
        allowlist: new Set(['fflate']),
      }),
    /fflate.*exact version/i,
  );
});

test('resolves runtime lock versions from the workspace before hoisted dev packages', () => {
  const args = {
    dependencies: { fflate: '0.8.2' },
    allowlist: new Set(['fflate']),
    lockfile: {
      packages: {
        'packages/docsluice': { dependencies: { fflate: '0.8.2' } },
        'packages/docsluice/node_modules/fflate': { version: '0.8.2' },
        'node_modules/fflate': { version: '0.8.3', dev: true },
      },
    },
  };
  assert.doesNotThrow(() => validateRuntimeDependencies(args));
  assert.throws(
    () =>
      validateRuntimeDependencies({
        ...args,
        lockfile: {
          packages: {
            ...args.lockfile.packages,
            'packages/docsluice/node_modules/fflate': { version: '0.8.3' },
            'node_modules/fflate': { version: '0.8.2' },
          },
        },
      }),
    /fflate package-lock version 0.8.3 does not match 0.8.2/i,
  );
  assert.doesNotThrow(() =>
    validateRuntimeDependencies({
      ...args,
      lockfile: {
        packages: {
          'packages/docsluice': args.lockfile.packages['packages/docsluice'],
          'packages/node_modules/fflate': { version: '0.8.2' },
          'node_modules/fflate': { version: '0.8.3', dev: true },
        },
      },
    }),
  );
});

test('finds install lifecycle scripts in nested and scoped packages', async () => {
  const root = await makeTempRoot();
  try {
    const nested = path.join(root, 'node_modules', 'parent', 'node_modules', '@scope', 'child');
    await mkdir(nested, { recursive: true });
    await writeFile(
      path.join(nested, 'package.json'),
      JSON.stringify({ name: '@scope/child', version: '1.0.0', scripts: { postinstall: 'node build.js' } }),
    );

    assert.deepEqual(await collectPackagesWithInstallScripts(root), [
      { name: '@scope/child', path: path.join(nested, 'package.json'), script: 'postinstall' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finds packages that trigger npm’s implicit node-gyp install', async () => {
  const root = await makeTempRoot();
  try {
    const packageDir = path.join(root, 'node_modules', 'native-addon');
    await mkdir(packageDir, { recursive: true });
    await writeFile(
      path.join(packageDir, 'package.json'),
      JSON.stringify({ name: 'native-addon', version: '1.0.0', gypfile: true }),
    );

    assert.deepEqual(await collectPackagesWithInstallScripts(root), [
      { name: 'native-addon', path: path.join(packageDir, 'package.json'), script: 'gypfile' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('finds binding.gyp and respects gypfile false', async () => {
  const root = await makeTempRoot();
  try {
    const activeDir = path.join(root, 'node_modules', 'active-addon');
    const disabledDir = path.join(root, 'node_modules', 'disabled-addon');
    await mkdir(activeDir, { recursive: true });
    await mkdir(disabledDir, { recursive: true });
    await writeFile(path.join(activeDir, 'package.json'), JSON.stringify({ name: 'active-addon' }));
    await writeFile(path.join(activeDir, 'binding.gyp'), '{}');
    await writeFile(
      path.join(disabledDir, 'package.json'),
      JSON.stringify({ name: 'disabled-addon', gypfile: false }),
    );
    await writeFile(path.join(disabledDir, 'binding.gyp'), '{}');

    assert.deepEqual(await collectPackagesWithInstallScripts(root), [
      { name: 'active-addon', path: path.join(activeDir, 'package.json'), script: 'gypfile' },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fails closed when node_modules is missing', async () => {
  const root = await makeTempRoot();
  try {
    await assert.rejects(collectPackagesWithInstallScripts(root), /node_modules directory is missing/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

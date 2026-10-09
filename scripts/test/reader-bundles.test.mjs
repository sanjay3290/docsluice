import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { assertGzipBudget, assertLazyReaderGraph, getOfficeReaderExports } from '../check-reader-bundles.mjs';

const chunk = (overrides = {}) => ({
  type: 'chunk',
  fileName: 'entry.js',
  code: '',
  isEntry: false,
  isDynamicEntry: false,
  facadeModuleId: null,
  moduleIds: [],
  modules: {},
  imports: [],
  dynamicImports: [],
  ...overrides,
});

test('gzip budgets reject an oversized emitted bundle', () => {
  const incompressible = Array.from({ length: 4096 }, (_, index) =>
    String.fromCharCode((index * 73) % 251),
  ).join('');
  assert.throws(() => assertGzipBudget('DOC', [chunk({ code: incompressible })], 64), /DOC.*gzip.*64 bytes/);
});

test('configured reader gzip budget is exactly 40,000 decimal bytes', async () => {
  const { checkBuiltPackage } = await import('../check-reader-bundles.mjs');
  const { limitBytes } = (await checkBuiltPackage()).readers[0];
  assert.equal(limitBytes, 40_000);

  const exactLimit = fixtureWithGzipSize(40_000);
  const overLimit = fixtureWithGzipSize(40_001);
  assert.equal(gzipSync(exactLimit).byteLength, 40_000);
  assert.equal(gzipSync(overLimit).byteLength, 40_001);
  assert.equal(assertGzipBudget('DOC', [chunk({ code: exactLimit })], limitBytes), limitBytes);
  assert.throws(
    () => assertGzipBudget('DOC', [chunk({ code: overLimit })], limitBytes),
    new RegExp(`DOC gzip size 40001 bytes exceeds ${limitBytes} bytes`),
  );
});

function fixtureWithGzipSize(targetBytes) {
  const source = (length) => {
    let state = 123456789;
    let result = '';
    for (let index = 0; index < length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      result += String.fromCharCode(33 + ((state >>> 0) % 94));
    }
    return result;
  };

  let low = 1;
  let high = targetBytes + 10_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (gzipSync(source(middle)).byteLength < targetBytes) low = middle + 1;
    else high = middle;
  }
  const result = source(low);
  assert.equal(gzipSync(result).byteLength, targetBytes, 'fixture must hit exact gzip boundary');
  return result;
}

test('lazy graph accepts a reader reachable from a dynamic chunk', () => {
  const output = [
    chunk({
      fileName: 'index.js',
      isEntry: true,
      facadeModuleId: '/pkg/dist/index.js',
      moduleIds: ['/pkg/dist/index.js', '/pkg/dist/core/registry.js'],
      dynamicImports: ['doc.js'],
    }),
    chunk({
      fileName: 'doc.js',
      isDynamicEntry: true,
      facadeModuleId: '/pkg/dist/doc.js',
      moduleIds: ['/pkg/dist/doc.js', '/pkg/dist/readers/doc/index.js'],
    }),
  ];

  assert.equal(
    assertLazyReaderGraph(output, {
      entryModule: '/pkg/dist/index.js',
      readerModule: '/pkg/dist/readers/doc/index.js',
    }),
    true,
  );
});

test('lazy graph rejects readers included in the public entry chunk', () => {
  const output = [
    chunk({
      fileName: 'index.js',
      isEntry: true,
      facadeModuleId: '/pkg/dist/index.js',
      moduleIds: ['/pkg/dist/index.js', '/pkg/dist/readers/doc/index.js'],
      dynamicImports: ['doc.js'],
    }),
    chunk({
      fileName: 'doc.js',
      isDynamicEntry: true,
      moduleIds: ['/pkg/dist/readers/doc/index.js'],
    }),
  ];

  assert.throws(
    () =>
      assertLazyReaderGraph(output, {
        entryModule: '/pkg/dist/index.js',
        readerModule: '/pkg/dist/readers/doc/index.js',
      }),
    /eagerly includes.*readers\/doc/,
  );
});

test('lazy graph rejects readers in statically imported public chunks', () => {
  const output = [
    chunk({
      fileName: 'index.js',
      isEntry: true,
      facadeModuleId: '/pkg/dist/index.js',
      moduleIds: ['/pkg/dist/index.js'],
      imports: ['shared.js'],
      dynamicImports: ['doc.js'],
    }),
    chunk({
      fileName: 'shared.js',
      moduleIds: ['/pkg/dist/readers/doc/index.js'],
    }),
    chunk({
      fileName: 'doc.js',
      isDynamicEntry: true,
      moduleIds: ['/pkg/dist/readers/doc/index.js'],
    }),
  ];

  assert.throws(
    () =>
      assertLazyReaderGraph(output, {
        entryModule: '/pkg/dist/index.js',
        readerModule: '/pkg/dist/readers/doc/index.js',
      }),
    /eagerly includes.*readers\/doc/,
  );
});

test('lazy graph rejects a declared reader missing from emitted chunks', () => {
  const output = [
    chunk({
      fileName: 'index.js',
      isEntry: true,
      facadeModuleId: '/pkg/dist/index.js',
      moduleIds: ['/pkg/dist/index.js'],
    }),
  ];

  assert.throws(
    () =>
      assertLazyReaderGraph(output, {
        entryModule: '/pkg/dist/index.js',
        readerModule: '/pkg/dist/readers/doc/index.js',
      }),
    /does not contain declared reader module/,
  );
});

test('the declared Office reader export set matches the configured budget catalog', async () => {
  const exports = await getOfficeReaderExports({
    packageJson: {
      exports: {
        '.': { import: './dist/index.js' },
        './doc': { import: './dist/doc.js' },
      },
    },
    expected: ['doc'],
  });
  assert.deepEqual(exports, [{ subpath: 'doc', entry: './dist/doc.js' }]);

  await assert.rejects(
    getOfficeReaderExports({
      packageJson: { exports: { '.': { import: './dist/index.js' } } },
      expected: ['doc'],
    }),
    /missing expected Office reader export.*doc/,
  );

  await assert.rejects(
    getOfficeReaderExports({
      packageJson: {
        exports: {
          '.': { import: './dist/index.js' },
          './doc': { import: './dist/doc.js' },
          './xlsx': { import: './dist/xlsx.js' },
        },
      },
      expected: ['doc'],
    }),
    /no configured budgets: xlsx/,
  );
});

test('built public entry keeps DOC lazy and the built DOC reader is reachable', async () => {
  const { checkBuiltPackage } = await import('../check-reader-bundles.mjs');
  const result = await checkBuiltPackage();
  assert.deepEqual(
    result.readers.map(({ subpath }) => subpath),
    ['doc'],
  );
  assert.equal(result.readers[0].limitBytes, 40_000);
  assert.ok(result.readers[0].gzipBytes <= 40_000);
});

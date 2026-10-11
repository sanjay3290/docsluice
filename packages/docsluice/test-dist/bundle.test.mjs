import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { rolldown } from 'rolldown';
import sizeLimits, { PLUGINS, READERS } from '../.size-limit.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const dist = join(packageRoot, 'dist');

test('every reader subpath has a bundle budget (RT-5)', () => {
  assert.ok(READERS.includes('docx') && READERS.includes('xlsx') && READERS.includes('pptx'));
  for (const reader of READERS) {
    const entry = sizeLimits.find((item) => item.path === `dist/${reader}.js`);
    assert.ok(entry, `${reader} has a size-limit entry`);
    assert.ok(entry.limit && entry.gzip, `${reader} has a gzipped limit`);
  }
});

test('importing extract from docsluice loads every reader lazily (RT-4)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'docsluice-bundle-'));
  try {
    const input = join(directory, 'app.mjs');
    await writeFile(
      input,
      `import { extract } from ${JSON.stringify(join(dist, 'index.js'))};\nexport { extract };\n`,
    );
    const bundle = await rolldown({ input, logLevel: 'silent' });
    const { output } = await bundle.generate({ format: 'esm' });
    await bundle.close();
    const chunks = output.filter((item) => item.type === 'chunk');
    const entry = chunks.find((chunk) => chunk.isEntry);
    assert.ok(entry, 'the app has an entry chunk');
    const readerFile = (reader) => join(dist, `${reader}.js`);
    for (const plugin of PLUGINS) {
      const owner = chunks.find((chunk) => chunk.moduleIds.includes(readerFile(plugin)));
      assert.equal(owner, undefined, `${plugin} plugin is opt-in and never bundled`);
    }
    for (const reader of READERS.filter((name) => !PLUGINS.includes(name))) {
      assert.ok(!entry.moduleIds.includes(readerFile(reader)), `${reader} reader is not in the entry chunk`);
      const owner = chunks.find((chunk) => chunk.moduleIds.includes(readerFile(reader)));
      assert.ok(owner, `${reader} reader is bundled`);
      assert.ok(owner.isDynamicEntry, `${reader} reader is a dynamically imported chunk`);
    }
    // The PDF engine (unpdf's pdf.js build) loads only when a PDF arrives (ADR 0009).
    const engineModules = (chunk) => chunk.moduleIds.filter((id) => /\/pdfjs-[^/]+\.js$/.test(id));
    assert.equal(engineModules(entry).length, 0, 'the PDF engine is not in the entry chunk');
    const engine = chunks.find((chunk) => engineModules(chunk).length > 0);
    assert.ok(engine, 'the PDF engine is bundled');
    assert.ok(engine.isDynamicEntry || !engine.isEntry, 'the PDF engine is a lazily loaded chunk');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('each built engine contains both prefetch patches and its license header', async () => {
  const files = (await readdir(dist)).filter((name) => /^pdfjs-.*\.(?:js|cjs)$/.test(name));
  assert.equal(files.length, 2);
  for (const file of files) {
    const code = await readFile(join(dist, file), 'utf8');
    assert.equal([...code.matchAll(/docsluicePdfPrefetch\(/g)].length, 3, file);
    for (const [method, next] of [
      ['async getPageDict(', 'async getAllPageDicts('],
      ['async getPageIndex(', 'get baseUrl('],
    ]) {
      const start = code.indexOf(method);
      const end = code.indexOf(next, start);
      assert.ok(start >= 0 && end > start, `${file}: ${method}`);
      assert.equal([...code.slice(start, end).matchAll(/docsluicePdfPrefetch\(/g)].length, 1, method);
    }
    assert.match(code, /promise\.catch\(\(\) => \{\}\)/);
    assert.match(code, /Copyright.*Mozilla Foundation/);
    assert.match(code, /Apache-2\.0/);
  }
  const notices = await readFile(join(dist, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  assert.match(notices, /Apache License/);
  assert.match(notices, /MIT License/);
});

test('malformed page-tree prefetch cannot crash a process with either package entry', () => {
  for (const format of ['esm', 'cjs']) {
    const load =
      format === 'esm' ? "await import('docsluice')" : "createRequire(import.meta.url)('docsluice')";
    const result = spawnSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      const { extract } = ${load};
      for (const [file, pages] of [
        ['unused-malformed-page-kid.pdf', 1],
        ['page-kids-prefetch-rejection.pdf', 1],
        ['missing-outline-page.pdf', 1],
        ['page-index-prefetch-rejection.pdf', 2],
      ]) {
        const bytes = new Uint8Array(readFileSync('../../hostile/pdf/' + file));
        const document = await extract(bytes, { format: 'pdf' });
        if (document.metadata.pageCount !== pages) throw new Error('Page count mismatch');
        await new Promise(resolve => setImmediate(resolve));
      }
    `,
      ],
      { cwd: packageRoot, encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
  }
});

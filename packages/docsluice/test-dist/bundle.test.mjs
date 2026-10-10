import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    const engineModules = (chunk) => chunk.moduleIds.filter((id) => id.includes('/node_modules/unpdf/'));
    assert.equal(engineModules(entry).length, 0, 'the PDF engine is not in the entry chunk');
    const engine = chunks.find((chunk) => engineModules(chunk).length > 0);
    assert.ok(engine, 'the PDF engine is bundled');
    assert.ok(engine.isDynamicEntry || !engine.isEntry, 'the PDF engine is a lazily loaded chunk');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

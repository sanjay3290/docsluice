// Runs the BUILT package with node:test on every supported Node version (Node 20+).
// Vitest needs Node 22+, so this file proves the published output works on Node 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const renderDoc = {
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
  blocks: [
    { kind: 'heading', level: 1, text: 'Title', loc: {} },
    { kind: 'table', rows: [[{ text: 'a' }, { text: 'b' }]], headerRows: 1, loc: {} },
  ],
  children: [],
  warnings: [],
  stats: { bytesRead: 0, durationMs: 0, truncated: false, needsOcr: false },
};

test('ESM entry loads', async () => {
  const mod = await import('../dist/index.js');
  assert.equal(typeof mod.resolveLimits, 'function');
  assert.equal(mod.DEFAULT_LIMITS.zipEntries, 10_000);
  assert.equal(typeof mod.parseXml, 'function');
  assert.equal(typeof mod.scanXml, 'function');
  const image = await mod.extract(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));
  assert.equal(image.format, 'png');
  assert.deepEqual(image.blocks, []);
  assert.equal(mod.toText(renderDoc), 'Title\n\na\tb');
  assert.equal(typeof mod.toJSON, 'function');
  assert.equal(
    (await mod.detect(Uint8Array.of(123, 34, 111, 107, 34, 58, 116, 114, 117, 101, 125))).format,
    'json',
  );
  const warnings = new mod.WarningSink();
  const budget = new mod.Budget(mod.DEFAULT_LIMITS, { warnings });
  const tree = mod.parseXml('<root>text</root>', { budget, warnings });
  assert.equal(tree?.children[0], 'text');
});

test('CJS entry loads', () => {
  const mod = require('../dist/index.cjs');
  assert.equal(typeof mod.resolveLimits, 'function');
  assert.equal(mod.toText(renderDoc), 'Title\n\na\tb');
  assert.equal(typeof mod.toJSON, 'function');
});

test('node entry loads', async () => {
  const mod = await import('../dist/node/index.js');
  assert.equal(typeof mod.DocsluiceError, 'function');
});

test('node entry extracts files and Readable streams', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Readable } = await import('node:stream');
  const mod = await import('docsluice/node');
  const directory = await mkdtemp(join(tmpdir(), 'docsluice-smoke-'));
  try {
    const path = join(directory, 'x.csv');
    await writeFile(path, 'a,b\n1,2\n');
    const fromFile = await mod.extractFile(path);
    assert.equal(fromFile.format, 'csv');
    const fromStream = await mod.extract(Readable.from([Uint8Array.of(0x70, 0x6c, 0x61, 0x69, 0x6e)]));
    assert.equal(fromStream.format, 'txt');
    const cjs = require('../dist/node/index.cjs');
    assert.equal(typeof cjs.extractFile, 'function');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('DOC reader subpath loads lazily', async () => {
  const mod = await import('docsluice/doc');
  assert.equal(mod.docReader.id, 'doc');
  assert.equal(typeof mod.docReader.read, 'function');
});

test('TXT and Markdown reader subpaths load lazily', async () => {
  const txt = await import('docsluice/txt');
  assert.equal(txt.txtReader.id, 'txt');
  const markdown = await import('docsluice/markdown');
  assert.equal(markdown.markdownReader.id, 'markdown');
});

test('CSV and TSV reader subpaths load lazily', async () => {
  const csv = await import('docsluice/csv');
  assert.equal(csv.csvReader.id, 'csv');
  const tsv = await import('docsluice/tsv');
  assert.equal(tsv.tsvReader.id, 'tsv');
});

test('JSON and XML reader subpaths load lazily', async () => {
  const json = await import('docsluice/json');
  assert.equal(json.jsonReader.id, 'json');
  const xml = await import('docsluice/xml');
  assert.equal(xml.xmlReader.id, 'xml');
});

test('HTML reader subpath loads lazily', async () => {
  const html = await import('docsluice/html');
  assert.equal(html.htmlReader.id, 'html');
});

test('DOCX reader subpath loads lazily', async () => {
  const docx = await import('docsluice/docx');
  assert.equal(docx.docxReader.id, 'docx');
});

test('XLSX reader subpath loads lazily', async () => {
  const xlsx = await import('docsluice/xlsx');
  assert.equal(xlsx.xlsxReader.id, 'xlsx');
});

test('XLS reader subpath loads lazily', async () => {
  const xls = await import('docsluice/xls');
  assert.equal(xls.xlsReader.id, 'xls');
});

test('PPTX reader subpath loads lazily', async () => {
  const pptx = await import('docsluice/pptx');
  assert.equal(pptx.pptxReader.id, 'pptx');
});

test('ODT reader subpath loads lazily', async () => {
  const odt = await import('docsluice/odt');
  assert.equal(odt.odtReader.id, 'odt');
});

test('RTF reader subpath loads lazily', async () => {
  const rtf = await import('docsluice/rtf');
  assert.equal(rtf.rtfReader.id, 'rtf');
});

test('ZIP container reader subpath loads lazily', async () => {
  const zip = await import('docsluice/zip');
  assert.equal(zip.zipReader.id, 'zip');
});

test('GZIP and TAR reader subpaths load lazily', async () => {
  const gzip = await import('docsluice/gzip');
  const tar = await import('docsluice/tar');
  assert.equal(gzip.gzipReader.id, 'gzip');
  assert.equal(tar.tarReader.id, 'tar');
});

test('EML reader subpath loads lazily', async () => {
  const eml = await import('docsluice/eml');
  assert.equal(eml.emlReader.id, 'eml');
});

test('EPUB reader subpath loads lazily', async () => {
  const epub = await import('docsluice/epub');
  assert.equal(epub.epubReader.id, 'epub');
});

test('chunk is exported from the main entry', async () => {
  const docsluice = await import('docsluice');
  assert.equal(typeof docsluice.chunk, 'function');
});

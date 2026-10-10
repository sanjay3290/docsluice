// Runs the BUILT package with node:test on every supported Node version (Node 20+).
// Vitest needs Node 22+, so this file proves the published output works on Node 20.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { TextEncoder } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

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
  // An image gives one image block (size unknown for a bare signature) and no text.
  assert.deepEqual(
    image.blocks.map((block) => [block.kind, block.mimeType]),
    [['image', 'image/png']],
  );
  assert.equal(mod.toText(renderDoc), 'Title\n\na\tb');
  assert.deepEqual(
    mod
      .toRecords({
        ...renderDoc.blocks[1],
        rows: [...renderDoc.blocks[1].rows, [{ text: '1' }, { text: '2' }]],
      })
      .map((record) => ({ ...record })),
    [{ a: '1', b: '2' }],
  );
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
  assert.equal(typeof mod.toRecords, 'function');
  assert.equal(typeof mod.toJSON, 'function');
});

test('the JSON Schema is built and exported as docsluice/schema.json (MOD-2)', () => {
  const schema = require('docsluice/schema.json');
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.match(schema.$id, /^urn:docsluice:schema:document:v\d+$/);
  assert.equal(schema.$ref, '#/$defs/DocsluiceDocument');
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
  const yaml = await import('docsluice/yaml');
  assert.equal(yaml.yamlReader.id, 'yaml');
  const ndjson = await import('docsluice/ndjson');
  assert.equal(ndjson.ndjsonReader.id, 'ndjson');
  const media = await import('docsluice/media');
  assert.equal(media.audioReader.id, 'audio');
  assert.equal(media.videoReader.id, 'video');
  const ics = await import('docsluice/ics');
  assert.equal(ics.icsReader.id, 'ics');
  const vcf = await import('docsluice/vcf');
  assert.equal(vcf.vcfReader.id, 'vcf');
  const srt = await import('docsluice/srt');
  assert.equal(srt.srtReader.id, 'srt');
  const vtt = await import('docsluice/vtt');
  assert.equal(vtt.vttReader.id, 'vtt');
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
  const xlsb = await import('docsluice/xlsb');
  assert.equal(xlsb.xlsbReader.id, 'xlsb');
});

test('7z and RAR plugins load from their subpaths', async () => {
  const { sevenZipPlugin } = await import('docsluice/7z');
  assert.equal(sevenZipPlugin.id, '7z');
  const { rarPlugin } = await import('docsluice/rar');
  assert.equal(rarPlugin.id, 'rar');
});

test('PPT reader subpath loads lazily', async () => {
  const ppt = await import('docsluice/ppt');
  assert.equal(ppt.pptReader.id, 'ppt');
});

test('VSDX reader subpath loads lazily', async () => {
  const vsdx = await import('docsluice/vsdx');
  assert.equal(vsdx.vsdxReader.id, 'vsdx');
});

test('PPTX reader subpath loads lazily', async () => {
  const pptx = await import('docsluice/pptx');
  assert.equal(pptx.pptxReader.id, 'pptx');
});

test('ODT reader subpath loads lazily', async () => {
  const odt = await import('docsluice/odt');
  assert.equal(odt.odtReader.id, 'odt');
});

test('image reader subpath loads lazily', async () => {
  const image = await import('docsluice/image');
  assert.equal(image.imageReader.id, 'image');
});

test('ODS reader subpath loads lazily', async () => {
  const ods = await import('docsluice/ods');
  assert.equal(ods.odsReader.id, 'ods');
});

test('ODP reader subpath loads lazily', async () => {
  const odp = await import('docsluice/odp');
  assert.equal(odp.odpReader.id, 'odp');
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

test('MBOX reader subpath loads lazily', async () => {
  const mbox = await import('docsluice/mbox');
  assert.equal(mbox.mboxReader.id, 'mbox');
});

test('EML reader subpath loads lazily', async () => {
  const eml = await import('docsluice/eml');
  assert.equal(eml.emlReader.id, 'eml');
  const msg = await import('docsluice/msg');
  assert.equal(msg.msgReader.id, 'msg');
});

test('EPUB reader subpath loads lazily', async () => {
  const epub = await import('docsluice/epub');
  assert.equal(epub.epubReader.id, 'epub');
});

test('chunk is exported from the main entry', async () => {
  const docsluice = await import('docsluice');
  assert.equal(typeof docsluice.chunk, 'function');
});

/** A heap-size flag in the shell overrides worker resourceLimits; the pool then refuses to run. */
const heapFlagSet = [...process.execArgv, process.env.NODE_OPTIONS ?? ''].some((argument) =>
  /--max[-_]old[-_]space[-_]size/.test(argument),
);

async function checkWorker(mod) {
  const extractor = mod.createExtractor({ poolSize: 2, timeMs: 30_000 });
  try {
    const result = extractor.extract(new TextEncoder().encode('hello from a worker'));
    if (heapFlagSet) await assert.rejects(result, mod.WorkerIsolationError);
    else {
      const document = await result;
      assert.equal(document.format, 'txt');
      assert.equal(document.blocks[0].text, 'hello from a worker');
    }
  } finally {
    await extractor.close();
  }
}

test('worker subpath extracts in an isolated thread (ESM)', async () => {
  await checkWorker(await import('docsluice/worker'));
});

test('worker subpath extracts in an isolated thread (CommonJS)', async () => {
  await checkWorker(require('docsluice/worker'));
});

// PRD section 18: every example, run through the built `bin` entry. The PDF reader is not merged
// yet (#45), so the first two examples use a DOCX for report.pdf.
const cli = fileURLToPath(new URL('../dist/node/cli.js', import.meta.url));
const corpus = (path) => fileURLToPath(new URL(`../../../corpus/${path}`, import.meta.url));
const runCli = (args, options = {}) =>
  spawnSync(process.execPath, [options.entry ?? cli, ...args], {
    cwd: options.cwd,
    input: options.input,
    encoding: 'utf8',
    timeout: 30_000,
  });

test('CLI: docsluice report.docx prints Markdown, and --format text prints text', () => {
  const markdown = runCli([corpus('docx/headings-outline.docx')]);
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /^# Field Notes: Tidal Gardens/m);
  assert.equal(markdown.stderr, '');
  const text = runCli([corpus('docx/headings-outline.docx'), '--format', 'text']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^Field Notes: Tidal Gardens$/m);
  assert.doesNotMatch(text.stdout, /^# /m);
});

test('CLI: docsluice data.xlsx --format json', () => {
  const result = runCli([corpus('xlsx/workbook-values-formulas.xlsx'), '--format', 'json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).format, 'xlsx');
});

test('CLI: docsluice mail.eml --children list', () => {
  const result = runCli([
    corpus('eml/mixed-order-attachments.eml'),
    '--children',
    'list',
    '--format',
    'json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.deepEqual(
    document.children.map((child) => [child.name, child.status]),
    [
      ['bundle.zip', 'listed'],
      ['note.docx', 'listed'],
    ],
  );
});

test('CLI: cat file.docx | docsluice - --format markdown', () => {
  const result = runCli(['-', '--format', 'markdown'], {
    input: readFileSync(corpus('docx/headings-outline.docx')),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Field Notes: Tidal Gardens/m);
});

test('CLI: docsluice "inbox/**/*.eml" --out-dir ./extracted writes one safe file per input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docsluice-cli-'));
  try {
    mkdirSync(join(directory, 'inbox', 'nested'), { recursive: true });
    copyFileSync(corpus('eml/plain.eml'), join(directory, 'inbox', 'plain.eml'));
    copyFileSync(corpus('eml/html-only.eml'), join(directory, 'inbox', 'nested', 'html-only.eml'));
    copyFileSync(corpus('eml/plain.eml'), join(directory, 'inbox', 'nested', 'plain.eml'));
    copyFileSync(corpus('eml/plain.eml'), join(directory, 'inbox', 'nested', 'a b;c.eml'));
    const result = runCli(['inbox/**/*.eml', '--out-dir', './extracted'], { cwd: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(readdirSync(join(directory, 'extracted')).sort(), [
      'a_b_c.md',
      'html-only.md',
      'plain-2.md',
      'plain.md',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CLI: docsluice detect unknown.bin', () => {
  const result = runCli(['detect', corpus('xlsx/workbook-values-formulas.xlsx')]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).format, 'xlsx');
});

test('CLI: exit codes, stderr warnings, --strict-exit and the npm bin symlink', () => {
  const directory = mkdtempSync(join(tmpdir(), 'docsluice-bin-'));
  try {
    const link = join(directory, 'docsluice');
    symlinkSync(cli, link);
    const viaLink = runCli(['-', '--format', 'text'], { entry: link, input: 'through the bin link\n' });
    assert.equal(viaLink.status, 0, viaLink.stderr);
    assert.equal(viaLink.stdout, 'through the bin link\n');
    const missing = runCli([join(directory, 'missing.docx')]);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /^docsluice: /);
    // An unknown RTF code page always warns: exit 2 only with --strict-exit.
    const rtf = '{\\rtf1\\ansicpg9999 text\\par}';
    const strict = runCli(['-', '--strict-exit'], { input: rtf });
    assert.equal(strict.status, 2);
    assert.match(strict.stderr, /^docsluice: ENCODING_GUESSED: /m);
    assert.equal(strict.stdout, 'text\n');
    assert.equal(runCli(['-'], { input: rtf }).status, 0);
    const help = runCli(['--help']);
    assert.equal(help.status, 0);
    for (const flag of [
      '--format',
      '--children',
      '--out-dir',
      '--strict-exit',
      '--no-metadata',
      '--password-env',
      '--max-bytes',
      '--timeout',
    ])
      assert.ok(help.stdout.includes(flag), flag);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

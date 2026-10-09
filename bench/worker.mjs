import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { URL, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { semanticResult } from './markers.mjs';

const [library, format, inputPath, expectedUnitsValue, markerValue] = process.argv.slice(2);
const expectedUnits = Number(expectedUnitsValue);
const markerPattern = new RegExp(markerValue, 'g');
const catalog = JSON.parse(readFileSync(new URL('./comparators.json', import.meta.url), 'utf8'));
const requireFromBenchDeps = process.env.DOCSLUICE_BENCH_NODE_MODULES
  ? createRequire(resolve(process.env.DOCSLUICE_BENCH_NODE_MODULES, '../package.json'))
  : undefined;

function countMarkers(text) {
  let count = 0;
  markerPattern.lastIndex = 0;
  while (markerPattern.exec(text)) count += 1;
  return count;
}

function summarizeText(text, units) {
  return { text: String(text), units };
}

async function parseWithDocsluice(bytes) {
  const { extract, toText } = await import('../packages/docsluice/dist/index.js');
  const document = await extract(bytes, { format });
  const text = toText(document);
  return summarizeText(text, countMarkers(text));
}

async function parseWithOfficeparser(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const { OfficeParser } = requireFromBenchDeps('officeparser');
  const document = await OfficeParser.parseOffice(bytes, { fileType: format });
  const text = (await document.to('text')).value;
  return summarizeText(text, countMarkers(text));
}

async function parseWithMammoth(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const mammoth = requireFromBenchDeps('mammoth');
  const result = await mammoth.extractRawText({ buffer: bytes });
  return summarizeText(result.value, countMarkers(result.value));
}

async function parseWithXlsx(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const xlsx = requireFromBenchDeps('xlsx');
  const workbook = xlsx.read(bytes, { type: 'buffer' });
  const rows = [];
  for (const sheetName of workbook.SheetNames) {
    rows.push(...xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, raw: false }));
  }
  const text = rows.map((row) => row.map(String).join('\t')).join('\n');
  return summarizeText(text, countMarkers(text));
}

async function parseWithPdfParse(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const { PDFParse } = requireFromBenchDeps('pdf-parse');
  const parser = new PDFParse({ data: bytes });
  try {
    const result = await parser.getText();
    return summarizeText(result.text, countMarkers(result.text));
  } finally {
    await parser.destroy();
  }
}

async function parseWithUnpdf(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const unpdfPath = requireFromBenchDeps.resolve('unpdf');
  const { extractText, getDocumentProxy } = await import(pathToFileURL(unpdfPath));
  const document = await getDocumentProxy(new Uint8Array(bytes));
  try {
    const result = await extractText(document, { mergePages: true });
    return summarizeText(result.text, countMarkers(result.text));
  } finally {
    await document.destroy?.();
  }
}

async function parseWithPdfJs(bytes) {
  if (!requireFromBenchDeps)
    throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
      code: 'BENCH_DEPENDENCIES_MISSING',
    });
  const pdfjsPath = requireFromBenchDeps.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pathToFileURL(pdfjsPath));
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: true,
    standardFontDataUrl: new URL('../../standard_fonts/', pathToFileURL(pdfjsPath)).href,
  });
  try {
    const document = await loadingTask.promise;
    let text = '';
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      text += content.items.map((item) => item.str ?? '').join(' ') + '\n';
    }
    return summarizeText(text, countMarkers(text));
  } finally {
    await loadingTask.destroy();
  }
}

const adapters = new Map([
  ['docsluice', parseWithDocsluice],
  ['officeparser', parseWithOfficeparser],
  ['mammoth', parseWithMammoth],
  ['xlsx', parseWithXlsx],
  ['pdf-parse', parseWithPdfParse],
  ['unpdf', parseWithUnpdf],
  ['pdfjs-dist', parseWithPdfJs],
]);

function packageMetadata(packageName) {
  const entry = requireFromBenchDeps.resolve(packageName);
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === packageName) return metadata;
    } catch {
      // Keep walking up from a package subpath until its package root is found.
    }
    directory = dirname(directory);
  }
  throw new Error(`Could not read installed metadata for ${packageName}.`);
}

async function main() {
  if (!adapters.has(library) || !['docx', 'xlsx', 'pdf'].includes(format) || !inputPath) {
    throw new Error('Usage: worker.mjs <library> <format> <input-path> <expected-units> <marker-regex>.');
  }
  if (!Number.isSafeInteger(expectedUnits) || expectedUnits < 1 || !markerValue) {
    throw new Error('Expected unit count and output marker are required.');
  }
  const benchmarkCase = catalog.cases.find((item) => item.format === format);
  if (!benchmarkCase) throw new Error(`No semantic marker registration is available for ${format}.`);
  if (expectedUnits !== benchmarkCase.expectedUnits || markerValue !== benchmarkCase.marker) {
    throw new Error(`Worker arguments do not match the registered ${format} benchmark case.`);
  }

  let adapter;
  try {
    adapter = adapters.get(library);
    if (library === 'docsluice') await import('../packages/docsluice/dist/index.js');
    else if (!requireFromBenchDeps)
      throw Object.assign(new Error('Set DOCSLUICE_BENCH_NODE_MODULES.'), {
        code: 'BENCH_DEPENDENCIES_MISSING',
      });
    else {
      const packageName = catalog.libraries[library]?.package;
      if (!packageName) throw new Error(`No package metadata is registered for ${library}.`);
      const installed = packageMetadata(packageName);
      const expected = catalog.libraries[library].version;
      if (installed.version !== expected) {
        throw Object.assign(
          new Error(`${packageName} ${installed.version} is installed; expected ${expected}.`),
          { code: 'BENCH_VERSION_MISMATCH' },
        );
      }
      if (
        library === 'officeparser' ||
        library === 'mammoth' ||
        library === 'xlsx' ||
        library === 'pdf-parse'
      )
        requireFromBenchDeps(packageName);
      else if (library === 'unpdf') await import(pathToFileURL(requireFromBenchDeps.resolve('unpdf')));
      else if (library === 'pdfjs-dist')
        await import(pathToFileURL(requireFromBenchDeps.resolve('pdfjs-dist/legacy/build/pdf.mjs')));
    }
  } catch (error) {
    if (
      error.code === 'BENCH_DEPENDENCIES_MISSING' ||
      error.code === 'MODULE_NOT_FOUND' ||
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      process.stdout.write(
        `${JSON.stringify({ status: 'unavailable', reason: 'dependency-not-installed', library })}\n`,
      );
      return;
    }
    throw error;
  }

  const bytes = await readFile(inputPath);
  const startedAt = performance.now();
  let extracted;
  try {
    extracted = await adapter(bytes);
  } catch (error) {
    if (error.code === 'UNSUPPORTED_FORMAT') {
      process.stdout.write(
        `${JSON.stringify({ status: 'unavailable', reason: 'reader-not-implemented', format })}\n`,
      );
      return;
    }
    throw error;
  }
  const durationMs = performance.now() - startedAt;
  const semantic = semanticResult({
    text: extracted.text,
    units: extracted.units,
    durationMs,
    markerOptions: {
      markerPattern: benchmarkCase.marker,
      markerPrefix: benchmarkCase.markerPrefix,
      markerWidth: benchmarkCase.markerWidth,
      expectedUnits,
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      ...semantic,
      format,
      library,
    })}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({ error: error.message, code: error.code ?? 'BENCH_WORKER_ERROR' })}\n`,
  );
  process.exitCode = 1;
});

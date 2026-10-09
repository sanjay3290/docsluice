import { readFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const fixtureRoot = '/workspace/package-e-preparation/pdf-fixtures/generated';
const candidateRoot =
  process.env.PDF_SPIKE_NODE_MODULES ?? '/tmp/docsluice-pdf-spike/node_modules';
const mode = process.argv[2] ?? 'unpdf';
const workerThreads = require('node:worker_threads');
const attempts = { fetch: 0, http: 0, https: 0, xhr: 0, worker: 0, eval: 0, functionConstructor: 0 };
globalThis.docsluiceMarker = 0;

const OriginalWorker = workerThreads.Worker;
workerThreads.Worker = class GuardedWorker extends OriginalWorker {
  constructor(...args) {
    attempts.worker += 1;
    throw new Error('Worker construction blocked by PDF probe');
  }
};
for (const [scheme, key] of [
  ['node:http', 'http'],
  ['node:https', 'https'],
]) {
  const client = require(scheme);
  for (const method of ['request', 'get']) {
    client[method] = (...args) => {
      attempts[key] += 1;
      throw new Error(`${scheme} ${method} blocked by PDF probe`);
    };
  }
}
syncBuiltinESMExports();
globalThis.Worker = class GuardedWebWorker {
  constructor() {
    attempts.worker += 1;
    throw new Error('Web Worker construction blocked by PDF probe');
  }
};
globalThis.fetch = async () => {
  attempts.fetch += 1;
  throw new Error('Network fetch blocked by PDF probe');
};
globalThis.XMLHttpRequest = class GuardedXMLHttpRequest {
  constructor() {
    attempts.xhr += 1;
    throw new Error('XHR blocked by PDF probe');
  }
};

const pdfjs =
  mode === 'legacy'
    ? await import(pathToFileURL(path.join(candidateRoot, 'pdfjs-dist/legacy/build/pdf.mjs')).href)
    : await (await import(pathToFileURL(path.join(candidateRoot, 'unpdf/dist/index.mjs')).href)).getResolvedPDFJS();

const originalEval = globalThis.eval;
const OriginalFunction = globalThis.Function;
globalThis.eval = (...args) => {
  attempts.eval += 1;
  throw new Error('eval blocked by PDF probe');
};
globalThis.Function = new Proxy(OriginalFunction, {
  apply() {
    attempts.functionConstructor += 1;
    throw new Error('Function call blocked by PDF probe');
  },
  construct() {
    attempts.functionConstructor += 1;
    throw new Error('Function constructor blocked by PDF probe');
  },
});

const options = {
  isEvalSupported: false,
  useWorkerFetch: false,
  useWasm: false,
  disableAutoFetch: true,
  disableStream: true,
  verbosity: 0,
};

async function parse(bytes) {
  if (mode === 'legacy') return await pdfjs.getDocument({ data: bytes, ...options }).promise;
  const unpdf = await import(pathToFileURL(path.join(candidateRoot, 'unpdf/dist/index.mjs')).href);
  return await unpdf.getDocumentProxy(bytes, options);
}

async function inspect(name, timed = false) {
  const bytes = new Uint8Array(await readFile(path.join(fixtureRoot, name)));
  const inputByteLength = bytes.byteLength;
  const start = performance.now();
  const pdf = await parse(bytes);
  const pages = [];
  let rawItemCount = 0;
  let textChars = 0;
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const annotations = await page.getAnnotations({ intent: 'display' });
    const pageItems = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      rawItemCount += 1;
      textChars += item.str.length;
      if (pageItems.length < 5) {
        pageItems.push({
          text: item.str,
          x: item.transform?.[4],
          y: item.transform?.[5],
          width: item.width,
          height: item.height,
          dir: item.dir,
          hasEOL: item.hasEOL,
        });
      }
    }
    pages.push({
      pageNumber,
      text: content.items.filter((item) => 'str' in item).map((item) => item.str).join(''),
      items: pageItems,
      annotations: pageNumber === 1 ? annotations.map(({ subtype, url, unsafeUrl, action, dest }) => ({ subtype, url, unsafeUrl, action, dest })) : undefined,
    });
    await page.cleanup();
  }
  const labels = await pdf.getPageLabels();
  const outline = await pdf.getOutline();
  const metadata = await pdf.getMetadata();
  const openAction = await pdf.getOpenAction();
  const jsActions = await pdf.getJSActions();
  const unpdf = await import(pathToFileURL(path.join(candidateRoot, 'unpdf/dist/index.mjs')).href);
  const structured = timed ? undefined : await unpdf.extractTextItems(pdf);
  const elapsedMs = performance.now() - start;
  await pdf.destroy();
  return {
    name,
    bytes: inputByteLength,
    pages: pdf.numPages,
    labels,
    outline: outline?.map(({ title }) => title) ?? null,
    title: metadata.info?.Title ?? null,
    author: metadata.info?.Author ?? null,
    pageText: pages.map(({ text }) => text),
    rawItemCount,
    textChars,
    firstPageItems: pages[0]?.items ?? [],
    firstPageAnnotations: pages[0]?.annotations ?? [],
    unpdfTextItems: structured
      ? {
          totalPages: structured.totalPages,
          firstPage: structured.items[0]?.slice(0, 5),
        }
      : undefined,
    openAction,
    jsActions,
    elapsedMs: timed ? Number(elapsedMs.toFixed(2)) : undefined,
  };
}

const result = {
  mode,
  node: process.version,
  pdfjsVersion: pdfjs.version,
  config: options,
  importResolved: true,
  markerBefore: globalThis.docsluiceMarker ?? 0,
  fixtures: [],
};

try {
  for (const name of [
    'labels-outline-links.pdf',
    'two-columns.pdf',
    'image-only.pdf',
    'hostile/actions.pdf',
  ]) {
    result.fixtures.push(await inspect(name));
  }
  // Warm the parse/extraction path once, then time 10 independent full parses.
  await inspect('text-100-pages.pdf');
  const perfRuns = [];
  for (let i = 0; i < 10; i += 1) {
    perfRuns.push(await inspect('text-100-pages.pdf', true));
  }
  const durations = perfRuns.map(({ elapsedMs }) => elapsedMs).sort((a, b) => a - b);
  result.performance = {
    runs: perfRuns.length,
    medianMs: durations[Math.floor(durations.length / 2)],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    firstResult: {
      pages: perfRuns[0]?.pages,
      rawItemCount: perfRuns[0]?.rawItemCount,
      textChars: perfRuns[0]?.textChars,
      firstPageText: perfRuns[0]?.pageText[0],
      lastPageText: perfRuns[0]?.pageText.at(-1),
    },
  };
  result.markerAfter = globalThis.docsluiceMarker ?? 0;
  result.attempts = attempts;
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  result.markerAfter = globalThis.docsluiceMarker ?? 0;
  result.attempts = attempts;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 1;
} finally {
  globalThis.eval = originalEval;
  globalThis.Function = OriginalFunction;
}

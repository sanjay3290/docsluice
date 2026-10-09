/* Runtime-neutral, throwaway PDF engine probe. No Node built-ins are needed in Bun/Deno. */
const runtime = globalThis.Deno ? 'deno' : globalThis.Bun ? 'bun' : 'unknown';
const args = globalThis.Deno ? Deno.args : process.argv.slice(2);
const [mode, fixtureRoot, moduleUrl] = args;
if (!['unpdf', 'legacy'].includes(mode) || !fixtureRoot || !moduleUrl) {
  throw new Error('usage: probe.mjs unpdf|legacy FIXTURE_DIR MODULE_FILE_URL');
}

const attempts = { fetch: 0, xhr: 0, worker: 0, eval: 0, functionConstructor: 0 };
const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const originalWorker = globalThis.Worker;
const originalEval = globalThis.eval;
const OriginalFunction = globalThis.Function;
const workerTrapInstalled = (() => {
  try {
    globalThis.Worker = class ProbeWorkerTrap {
      constructor() {
        attempts.worker += 1;
        throw new Error('Worker blocked by runtime probe');
      }
    };
    return globalThis.Worker !== originalWorker;
  } catch {
    return false;
  }
})();

globalThis.fetch = async () => {
  attempts.fetch += 1;
  throw new Error('fetch blocked by runtime probe');
};
globalThis.XMLHttpRequest = class ProbeXHRTrap {
  constructor() {
    attempts.xhr += 1;
    throw new Error('XMLHttpRequest blocked by runtime probe');
  }
};
globalThis.eval = (..._args) => {
  attempts.eval += 1;
  throw new Error('eval blocked by runtime probe');
};
globalThis.Function = new Proxy(OriginalFunction, {
  apply() {
    attempts.functionConstructor += 1;
    throw new Error('Function call blocked by runtime probe');
  },
  construct() {
    attempts.functionConstructor += 1;
    throw new Error('Function constructor blocked by runtime probe');
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
globalThis.docsluiceMarker = 0;

async function readBytes(path) {
  if (globalThis.Deno) return new Uint8Array(await Deno.readFile(path));
  if (globalThis.Bun) return new Uint8Array(await Bun.file(path).bytes());
  throw new Error('this probe is intended for Bun and Deno');
}

async function parse(bytes, pdfjs, unpdf) {
  // Construct a plain Uint8Array regardless of the runtime file API's return type.
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  if (mode === 'legacy') return await pdfjs.getDocument({ data, ...options }).promise;
  return await unpdf.getDocumentProxy(data, options);
}

function textItems(content) {
  return content.items.filter((item) => item && typeof item.str === 'string');
}

async function inspect(name, pdfjs, unpdf) {
  const bytes = await readBytes(`${fixtureRoot}/${name}`);
  const start = performance.now();
  const pdf = await parse(bytes, pdfjs, unpdf);
  const pageRecords = [];
  let itemCount = 0;
  let textChars = 0;
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = textItems(content);
      const text = items.map((item) => item.str).join('');
      itemCount += items.length;
      textChars += items.reduce((sum, item) => sum + item.str.length, 0);
      let annotations = [];
      if (pageNumber === 1 && typeof page.getAnnotations === 'function') {
        annotations = (await page.getAnnotations({ intent: 'display' })).map(
          ({ subtype, url, unsafeUrl, action, dest }) => ({ subtype, url, unsafeUrl, action, dest }),
        );
      }
      pageRecords.push({
        pageNumber,
        text,
        items: pageNumber === 1 ? items.slice(0, 5).map((item) => ({
          text: item.str,
          x: item.transform?.[4],
          y: item.transform?.[5],
          width: item.width,
          height: item.height,
          dir: item.dir,
          hasEOL: item.hasEOL,
        })) : undefined,
        annotations: pageNumber === 1 ? annotations : undefined,
      });
      await page.cleanup();
    }
    const labels = typeof pdf.getPageLabels === 'function' ? await pdf.getPageLabels() : null;
    const outline = typeof pdf.getOutline === 'function' ? await pdf.getOutline() : null;
    const metadata = typeof pdf.getMetadata === 'function' ? await pdf.getMetadata() : null;
    const openAction = typeof pdf.getOpenAction === 'function' ? await pdf.getOpenAction() : null;
    const jsActions = typeof pdf.getJSActions === 'function' ? await pdf.getJSActions() : null;
    return {
      name,
      inputByteLength: bytes.byteLength,
      pages: pdf.numPages,
      labels,
      outline: outline?.map(({ title }) => title) ?? null,
      title: metadata?.info?.Title ?? null,
      author: metadata?.info?.Author ?? null,
      pageText: pageRecords.map(({ text }) => text),
      rawItemCount: itemCount,
      textChars,
      firstPageItems: pageRecords[0]?.items ?? [],
      firstPageAnnotations: pageRecords[0]?.annotations ?? [],
      openAction,
      jsActions,
      elapsedMs: Number((performance.now() - start).toFixed(2)),
      cleanup: { pageCleanupCalls: pdf.numPages, documentDestroyed: true },
    };
  } finally {
    await pdf.destroy();
  }
}

const result = {
  runtime,
  runtimeVersion: globalThis.Deno?.version?.deno ?? globalThis.Bun?.version ?? null,
  mode,
  moduleUrl,
  config: options,
  workerTrapInstalled,
  workerCoverageNote: 'Only global Worker is trapped. This probe does not import or call node:worker_threads Worker.',
  markerBefore: globalThis.docsluiceMarker,
  fixtures: [],
};
let pdfjs;
let unpdf;
try {
  if (mode === 'legacy') {
    pdfjs = await import(moduleUrl);
    result.pdfjsVersion = pdfjs.version ?? null;
  } else {
    unpdf = await import(moduleUrl);
    pdfjs = await unpdf.getResolvedPDFJS();
    result.pdfjsVersion = pdfjs.version ?? null;
  }
  result.importResolved = true;
  for (const name of [
    'labels-outline-links.pdf',
    'two-columns.pdf',
    'image-only.pdf',
    'text-100-pages.pdf',
    'hostile/actions.pdf',
  ]) {
    result.fixtures.push(await inspect(name, pdfjs, unpdf));
  }
} catch (error) {
  result.importResolved ??= false;
  result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  result.markerAfter = globalThis.docsluiceMarker;
  result.attempts = attempts;
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
  if (workerTrapInstalled) globalThis.Worker = originalWorker;
  globalThis.eval = originalEval;
  globalThis.Function = OriginalFunction;
}
console.log(JSON.stringify(result, null, 2));
if (result.error) globalThis.Deno ? Deno.exit(1) : process.exitCode = 1;

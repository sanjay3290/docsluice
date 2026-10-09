import { getDocumentProxy, extractTextItems, getResolvedPDFJS } from 'unpdf';

const events = {
  fetch: 0,
  xhr: 0,
  worker: 0,
  eval: 0,
  functionApply: 0,
  functionConstruct: 0,
};
const patchErrors = [];
const originalFunction = globalThis.Function;
const originalEval = globalThis.eval;

function patch(name, apply) {
  try {
    apply();
    return true;
  } catch (error) {
    patchErrors.push(`${name}:${error?.name ?? 'Error'}`);
    return false;
  }
}

const originalFetch = globalThis.fetch;
const fetchGuardInstalled = patch('fetch', () => {
  globalThis.fetch = (...args) => {
    events.fetch += 1;
    throw new Error('blocked local worker network access');
  };
});
const evalGuardInstalled = patch('eval', () => {
  globalThis.eval = (...args) => {
    events.eval += 1;
    throw new Error('blocked local worker eval');
  };
});
const functionGuardInstalled = patch('Function', () => {
  globalThis.Function = new Proxy(originalFunction, {
    apply() {
      events.functionApply += 1;
      throw new Error('blocked local worker Function');
    },
    construct() {
      events.functionConstruct += 1;
      throw new Error('blocked local worker Function constructor');
    },
  });
});
const workerGuardInstalled = patch('Worker', () => {
  globalThis.Worker = class BlockedWorker {
    constructor() {
      events.worker += 1;
      throw new Error('blocked local worker nested Worker');
    }
  };
});
const xhrGuardInstalled = patch('XMLHttpRequest', () => {
  globalThis.XMLHttpRequest = class BlockedXhr {
    constructor() {
      events.xhr += 1;
      throw new Error('blocked local worker XHR');
    }
  };
});

const fixtures = __EMBEDDED_FIXTURES__;
const options = {
  isEvalSupported: false,
  useWasm: false,
  useWorkerFetch: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  verbosity: 0,
};
globalThis.docsluiceMarker = 0;

function visibleMetadata(info, enabled) {
  if (!enabled) return {};
  return {
    ...(typeof info?.Title === 'string' ? { title: info.Title } : {}),
    ...(typeof info?.Author === 'string' ? { authors: [info.Author] } : {}),
  };
}

async function inspect(name, isLarge = false) {
  const base64 = fixtures[name];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);

  const inputBytes = bytes.byteLength;
  const started = performance.now();
  const pdf = await getDocumentProxy(bytes, options);
  try {
    const structured = await extractTextItems(pdf);
    const labels = await pdf.getPageLabels();
    const outline = await pdf.getOutline();
    const metadata = await pdf.getMetadata();
    const openAction = await pdf.getOpenAction();
    const jsActions = await pdf.getJSActions();
    let annotations = [];
    if (pdf.numPages > 0 && name === 'labels-outline-links.pdf') {
      const page = await pdf.getPage(1);
      annotations = (await page.getAnnotations({ intent: 'display' })).map(({ subtype, url, unsafeUrl }) => ({
        subtype,
        url: url ?? null,
        unsafeUrl: unsafeUrl ?? null,
      }));
      await page.cleanup();
    }

    const pageText = structured.items.map((items) => items.map(({ str }) => str).join(''));
    const itemCount = structured.items.reduce((count, items) => count + items.length, 0);
    const textChars = pageText.reduce((count, text) => count + text.length, 0);
    const firstItems = structured.items[0]?.slice(0, 5).map(({ str, x, y, width, height, dir, hasEOL }) => ({
      str,
      x,
      y,
      width,
      height,
      dir,
      hasEOL,
    }));
    return {
      name,
      inputBytes,
      pages: pdf.numPages,
      labels,
      outlineTitles: outline?.map(({ title }) => title) ?? null,
      metadataEnabled: visibleMetadata(metadata.info, true),
      metadataDisabled: visibleMetadata(metadata.info, false),
      itemCount,
      textChars,
      pageText: isLarge ? undefined : pageText,
      firstPageItems: firstItems,
      firstPageAnnotations: annotations,
      openAction,
      jsActions,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      lastPageText: isLarge ? pageText.at(-1) : undefined,
    };
  } finally {
    await pdf.destroy();
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.pathname !== '/probe') return new Response('not found', { status: 404 });

    try {
      const pdfjs = await getResolvedPDFJS();
      const fixtureResults = [];
      for (const name of [
        'labels-outline-links.pdf',
        'two-columns.pdf',
        'image-only.pdf',
        'hostile-actions.pdf',
      ]) {
        fixtureResults.push(await inspect(name));
      }
      const large = await inspect('text-100-pages.pdf', true);
      const result = {
        status: 'LOCAL_WORKER_RUNTIME_PROBE_ONLY_NOT_ACCEPTANCE',
        runtime: 'Cloudflare workerd local process, loopback socket and explicit deny-all global outbound service',
        compatibilityDate: '2026-08-03',
        nodejsCompatEnabled: false,
        globalOutbound: 'deny-outbound',
        globalOutboundPolicy: 'network service with empty allow and deny lists; no network destination is allowed',
        bufferGlobalAvailable: typeof globalThis.Buffer !== 'undefined',
        candidate: 'unpdf@1.7.0 research candidate',
        pdfjsVersion: pdfjs.version,
        options,
        instrumentationInstalled: {
          fetch: fetchGuardInstalled,
          eval: evalGuardInstalled,
          Function: functionGuardInstalled,
          Worker: workerGuardInstalled,
          XMLHttpRequest: xhrGuardInstalled,
        },
        patchErrors,
        fixtureResults,
        hundredPage: large,
        globalMarkerBeforeAndAfter: [0, globalThis.docsluiceMarker],
        attempts: { ...events },
        moduleStaticImportCaveat: 'Guards install after static module imports; they cover parsing/API use, not bundle initialization.',
        metadataCleanupCaveat: 'metadataDisabled is an adapter-side no-personal-metadata projection check, not an unpdf option.',
      };
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        status: 'PROBE_ERROR',
        name: error?.name ?? null,
        message: String(error?.message ?? 'unknown error'),
        attempts: { ...events },
        patchErrors,
      }), { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  },
};

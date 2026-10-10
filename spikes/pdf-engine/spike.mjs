// Throwaway PDF engine spike (issue #44). Runtime-neutral: only web-standard globals.
// `run(engine, files)` loads one engine, reads every page's text items with positions, and
// reports page/item counts, timings and any network or code-generation attempts.

export const OPTIONS = {
  isEvalSupported: false,
  disableFontFace: true,
  useSystemFonts: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  useWorkerFetch: false,
  isOffscreenCanvasSupported: false,
  isImageDecoderSupported: false,
  enableXfa: false,
  stopAtErrors: false,
  maxImageSize: 16_777_216,
  verbosity: 0,
};

export function installTraps() {
  const calls = { fetch: 0, eval: 0, Function: 0, XMLHttpRequest: 0 };
  globalThis.fetch = () => {
    calls.fetch++;
    return Promise.reject(new Error('network is not allowed in the spike'));
  };
  if ('XMLHttpRequest' in globalThis) {
    globalThis.XMLHttpRequest = function () {
      calls.XMLHttpRequest++;
      throw new Error('network is not allowed in the spike');
    };
  }
  const realEval = globalThis.eval;
  globalThis.eval = (...args) => {
    calls.eval++;
    return realEval(...args);
  };
  const RealFunction = globalThis.Function;
  globalThis.Function = new Proxy(RealFunction, {
    apply(target, self, args) {
      calls.Function++;
      return Reflect.apply(target, self, args);
    },
    construct(target, args) {
      calls.Function++;
      return Reflect.construct(target, args);
    },
  });
  return calls;
}

async function loadEngine(engine, loaders) {
  return loaders[engine]();
}

export async function run(engine, files, loaders) {
  const calls = installTraps();
  const started = performance.now();
  const pdfjs = await loadEngine(engine, loaders);
  const loadMs = performance.now() - started;
  const results = [];
  for (const { name, bytes } of files) {
    const t0 = performance.now();
    const result = { name, pages: 0, items: 0, positioned: 0, chars: 0, ms: 0 };
    try {
      const task = pdfjs.getDocument({ data: bytes.slice(), ...OPTIONS });
      const pdf = await task.promise;
      result.pages = pdf.numPages;
      for (let index = 1; index <= pdf.numPages; index++) {
        const page = await pdf.getPage(index);
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          result.items++;
          result.chars += item.str.length;
          const t = item.transform;
          if (Array.isArray(t) && t.length === 6 && Number.isFinite(t[4]) && Number.isFinite(t[5]) && Number.isFinite(item.width)) {
            result.positioned++;
          }
        }
        page.cleanup();
      }
      await task.destroy();
    } catch (error) {
      result.error = `${error?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 120)}`;
    }
    result.ms = Math.round(performance.now() - t0);
    results.push(result);
  }
  return { engine, version: pdfjs.version, loadMs: Math.round(loadMs), calls, results };
}

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const unpdfUrl = pathToFileURL('/tmp/docsluice-unpdf-only/node_modules/unpdf/dist/index.mjs');
const fixtureDir = '/workspace/package-e-preparation/pdf-fixtures/advanced/generated';
const attachmentPdf = '/workspace/package-e-preparation/pdf-fixtures/attachments/attachments-edge-cases.pdf';
const events = { fetch: 0, eval: 0, functionConstructor: 0, workerConstructor: 0 };
const warnings = [];
const saved = {
  fetch: globalThis.fetch,
  eval: globalThis.eval,
  Function: globalThis.Function,
  Worker: globalThis.Worker,
};
globalThis.fetch = (...args) => { events.fetch++; throw new Error('probe blocked network fetch'); };
globalThis.eval = (...args) => { events.eval++; throw new Error('probe blocked eval'); };
globalThis.Function = new Proxy(saved.Function, {
  construct(target, args, newTarget) {
    events.functionConstructor++;
    throw new Error('probe blocked Function constructor');
  },
});
globalThis.Worker = class ProbeBlockedWorker {
  constructor() { events.workerConstructor++; throw new Error('probe blocked worker'); }
};
const originalWarn = console.warn;
console.warn = (...args) => { warnings.push(args.map((value) => String(value)).join(' ')); };

const { getDocumentProxy, getResolvedPDFJS } = await import(unpdfUrl.href);
const pdfjs = await getResolvedPDFJS();
const options = {
  isEvalSupported: false,
  useWasm: false,
  useWorkerFetch: false,
  disableAutoFetch: true,
  disableStream: true,
  disableRange: true,
  stopAtErrors: false,
};

function summaryError(error) {
  return {
    name: error?.name ?? null,
    constructor: error?.constructor?.name ?? null,
    message: String(error?.message ?? '').replace(/fixture-(?:owner|user)-secret/g, '[REDACTED]'),
    code: Number.isInteger(error?.code) ? error.code : null,
    reason: typeof error?.reason === 'string' ? error.reason : null,
    passwordLeaked: /fixture-(?:owner|user)-secret/.test(String(error?.message ?? '')),
  };
}

async function open(file, password) {
  const bytes = new Uint8Array(await readFile(file));
  const supplied = password === undefined ? {} : { password };
  const pdf = await getDocumentProxy(bytes, { ...options, ...supplied });
  try {
    const meta = await pdf.getMetadata();
    const permissions = await pdf.getPermissions();
    return {
      pages: pdf.numPages,
      fingerprints: pdf.fingerprints ?? null,
      info: meta?.info ?? null,
      permissions,
      encryptedSignal: Boolean(meta?.info?.IsEncrypted ?? permissions !== null),
      getFieldObjects: typeof pdf.getFieldObjects,
      getAttachments: typeof pdf.getAttachments,
      getPermissions: typeof pdf.getPermissions,
    };
  } finally {
    await pdf.destroy();
  }
}

const facts = {};
for (const [key, args] of [
  ['unencrypted', ['filled-form.pdf']],
  ['owner-empty', ['owner-password-only.pdf']],
  ['user-absent', ['user-password.pdf']],
  ['user-right', ['user-password.pdf', 'fixture-user-secret']],
  ['user-wrong', ['user-password.pdf', 'definitely-wrong']],
]) {
  try { facts[key] = { ok: true, ...(await open(path.join(fixtureDir, args[0]), args[1])) }; }
  catch (error) { facts[key] = { ok: false, error: summaryError(error) }; }
}

async function rawProbe(filename, kind) {
  const bytes = new Uint8Array(await readFile(filename));
  const pdf = await getDocumentProxy(bytes, options);
  try {
    if (kind === 'form') return { fields: await pdf.getFieldObjects() };
    if (kind === 'annotations') {
      const page = await pdf.getPage(1);
      return { annotations: await page.getAnnotations({ intent: 'display' }) };
    }
    if (kind === 'attachments') return { attachments: await pdf.getAttachments() };
  } finally { await pdf.destroy(); }
}

facts.form = await rawProbe(path.join(fixtureDir, 'filled-form.pdf'), 'form');
facts.annotations = await rawProbe(path.join(fixtureDir, 'annotations.pdf'), 'annotations');
facts.attachments = await rawProbe(attachmentPdf, 'attachments');
facts.damaged = {};
for (const filename of ['truncated.pdf', 'corrupt-xref.pdf']) {
  const fullPath = `/workspace/package-e-preparation/pdf-fixtures/generated/hostile/${filename}`;
  try {
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(fullPath)), options);
    try {
      let page = null;
      let extractionError = null;
      try {
        page = await pdf.getPage(1);
        await page.getTextContent();
      } catch (error) { extractionError = summaryError(error); }
      facts.damaged[filename] = { loaded: true, pages: pdf.numPages, page1Returned: Boolean(page), extractionError };
    } finally { await pdf.destroy(); }
  } catch (error) { facts.damaged[filename] = { loaded: false, error: summaryError(error) }; }
}
facts.exports = {
  getDocumentProxy: typeof getDocumentProxy,
  getPDFProxy: typeof (await import(unpdfUrl.href)).getPDFProxy,
  pdfjsGetDocument: typeof pdfjs.getDocument,
  pdfjsPDFWorker: typeof pdfjs.PDFWorker,
};
facts.instrumentation = { ...events };
facts.consoleWarningSamples = [...new Set(warnings)].slice(0, 12);
facts.probeOptions = options;
facts.status = 'LOCAL_API_PROBE_ONLY_NOT_ACCEPTANCE_OR_RUNTIME_COMPATIBILITY';

// Scrub attachment bytes to length/hash/first-byte observations, not content.
const attachmentObject = facts.attachments.attachments;
if (attachmentObject && typeof attachmentObject === 'object') {
  const mapped = Object.entries(attachmentObject).map(([key, value]) => ({
    key,
    filename: value?.filename ?? null,
    contentLength: value?.content?.length ?? null,
    contentType: value?.content?.constructor?.name ?? null,
    isPrototypeKey: key === '__proto__',
    objectPrototype: Object.getPrototypeOf(attachmentObject) === null ? 'null' : 'ordinary-or-other',
  }));
  facts.attachments = { isNull: false, containerPrototype: Object.getPrototypeOf(attachmentObject) === null ? 'null' : 'ordinary', entries: mapped };
}
const output = JSON.stringify(facts, (_key, value) => {
  if (value instanceof Uint8Array) return { byteLength: value.length };
  return value;
}, 2) + '\n';
await writeFile(new URL('./probe-results.json', import.meta.url), output);
console.log(output);

Object.assign(globalThis, saved);
console.warn = originalWarn;

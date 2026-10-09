# Local PDF browser probe

This is throwaway compatibility evidence for proposed ADR 0009, not repository integration or a security proof. It serves the original local fixture bytes through `127.0.0.1` on an ephemeral port. It does not download fixtures or contact external assets.

## Run

Requirements: Node 20+, Chromium, Playwright; the exact probe packages from `/tmp/docsluice-pdf-spike` (`unpdf@1.7.0`, `pdfjs-dist@5.6.205`); and prepared fixtures under `/workspace/package-e-preparation/pdf-fixtures/generated`.

```sh
node /workspace/package-e-preparation/pdf/spike/browser-harness.cjs
```

Optional environment overrides:

```sh
PDF_SPIKE_CHROMIUM=/path/to/chromium \
PDF_SPIKE_PLAYWRIGHT=/path/to/playwright \
PDF_SPIKE_UNPDF_DIR=/tmp/docsluice-pdf-spike/node_modules/unpdf/dist \
PDF_SPIKE_PDFJS_DIR=/tmp/docsluice-pdf-spike/node_modules/pdfjs-dist/legacy/build \
PDF_SPIKE_FIXTURE_DIR=/workspace/package-e-preparation/pdf-fixtures/generated \
node /workspace/package-e-preparation/pdf/spike/browser-harness.cjs
```

`PDF_SPIKE_PLAYWRIGHT` must resolve to a CommonJS-loadable Playwright package. The script prints and writes `chromium-loopback-result.json`. It uses Playwright only to launch the local browser and inspect the title over the browser protocol; the page's PDF calls are API-only. It applies strict nonce CSP with `connect-src 'none'` and `worker-src 'none'`, and instruments fetch, Worker, XHR, eval, and Function construction. Browser module loading is restricted by the page script policy to the local fixture server. Expected HTTP requests are the local page, unpdf entry/chunk and legacy PDF engine entry.

## Result from Chromium 151.0.7922.173

Both unpdf and legacy PDF.js resolved engine version `5.6.205`. Each produced the expected counts: labels/outline fixture 3 pages / 73 text chars; two-column 1 / 62; image-only 1 / 0; 100-page fixture 100 / 3000; hostile-actions fixture 1 / 32. All five traps were zero for both runs; console and uncaught-error arrays were empty. `chromium-loopback-result.json` contains the full JSON result and actual ephemeral port.

Exact module, package-manifest, harness, and fixture SHA-256 values are in `browser-artifacts.sha256`. The Node binary provenance is in `node-runtime-evidence.txt`. Reproduction depends on the local package artifacts and fixture files whose hashes are listed there; do not treat these local results as hosted Workers, all-browser, malformed-PDF, or production-artifact acceptance.

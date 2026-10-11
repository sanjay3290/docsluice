# 0009. PDF engine: unpdf (serverless pdf.js), lazy-loaded

- Status: Accepted (confirmed by the PDF spike, issue #44, 2026-10-10)
- Date: 2026-10-09
- Requirement IDs: R1, PDF-1..PDF-10, RT-1, RT-2, SEC-10, SEC-11

## Context

A PDF parser written from scratch takes years (risk R1). pdf.js is the reference engine in JavaScript. `pdfjs-dist` assumes a browser or Node worker setup. `unpdf` ships a serverless build of pdf.js that runs in Node, Deno, Bun, browsers and edge workers.

## Decision

Vendor `unpdf` **1.8.1** at build time as an exact devDependency.
Use its serverless pdf.js build (exact pin; MIT; no dependencies; its serverless bundle reports pdf.js **6.1.200**) behind docsluice's own reading-order layer and budget. Load it only through dynamic `import()` when a PDF arrives. Turn off JavaScript evaluation, font loading from the network and every remote action (PDF-10, SEC-10).

How the PDF reader must use it:

- Import `getDocument` from `unpdf/pdfjs` and pass every option explicitly. Do **not** use `unpdf`'s `getDocumentProxy`: in Node it resolves `standardFontDataUrl` and `cMapUrl` to files of a local `pdfjs-dist` package, which reads the file system.
- Options used in the spike: `isEvalSupported: false`, `disableFontFace: true`, `useSystemFonts: false`, `disableAutoFetch: true`, `disableStream: true`, `disableRange: true`, `useWorkerFetch: false`, `isOffscreenCanvasSupported: false`, `isImageDecoderSupported: false`, `enableXfa: false`, `stopAtErrors: false`, `maxImageSize: 16_777_216`, `verbosity: 0`; no `standardFontDataUrl`, no `cMapUrl`. The serverless build inlines the pdf.js worker, so parsing runs in the calling thread with no `Worker`.
- pdf.js has no budget of its own: docsluice checks `pdfPages` against `numPages` before reading, ticks the budget between pages and text items, charges output characters, and caps image sizes.
- `PasswordException` maps to `EncryptedError` (PDF encryption, PDF-9).

## Spike results (issue #44)

Method: a throwaway harness (branch `spike-44-pdf-engine`, not merged) loaded each engine by dynamic `import()`, read every page's `getTextContent()` items of six PDFs — four corpus files (`headings-outline`, `lists-tables`, `deck-12-slides`, `scanned-image-only`), the corpus `encrypted-document`, and a 100-page text PDF made with LibreOffice 24.2 — and counted text items that carry a position (`transform[4]`, `transform[5]`) and a `width`. `fetch` and `XMLHttpRequest` were replaced with throwing stubs, and `eval` and `Function` were wrapped to count calls. In the browser the page was served with `Content-Security-Policy: default-src 'self'; script-src 'self'` (no `unsafe-eval`), and violations were collected. Workers ran in workerd through Miniflare 4, which forbids code generation from strings.

### unpdf 1.8.1

| Runtime | Works | Text items with positions | Network calls | `eval`/`Function` calls | 100-page PDF |
|---|---|---|---|---|---|
| Node 20.20.2 | yes | 8,783 / 8,783 | 0 | 0 | 0.41 s |
| Node 22.23.3 | yes | 8,783 / 8,783 | 0 | 0 | 0.45 s |
| Node 24.21.0 | yes | 8,783 / 8,783 | 0 | 0 | 0.37 s |
| Bun 1.4.2 | yes | 8,783 / 8,783 | 0 | 0 | 0.25 s |
| Deno 2.9.6 (`--deny-net`) | yes | 8,783 / 8,783 | 0 | 0 | 0.29 s |
| Chromium 141 (strict CSP) | yes | 8,783 / 8,783 | 0, no other requests | 0, no CSP violations | 0.27 s |
| workerd (Miniflare 4.20260730) | yes | 8,783 / 8,783 | 0 | 0 | 0.35 s |

- The encrypted file throws `PasswordException` in every runtime; the image-only scan gives a page with no text items (the `needsOcr` signal, PDF-4).
- A hand-made PDF with a non-embedded standard font (Helvetica) gives correct text, positions and widths with no font data, no fetch and no console output.
- Size: the engine alone, minified and gzipped, is about **480 KB** (1.57 MB minified). This sets the RT-5 exception: the PDF reader subpath gets its own budget of 500 KB gzipped instead of 40 KB.
- Install: one package, 2.6 MB, no install scripts and no native files. `@napi-rs/canvas` is only an optional peer, used for page rendering, which docsluice does not do.
- PERF-1 target for a 100-page text PDF is 3 s; every runtime is under 0.5 s for text items alone.

### pdfjs-dist 6.4.299 legacy build (the fallback)

| Check | Result |
|---|---|
| Node 20 | **fails**: `Promise.withResolvers is not a function` (needs Node 22+ or a polyfill) |
| Node 22, Node 24, Bun, Deno, Chromium | works, same text items, no network, no `eval` (in-thread worker via `globalThis.pdfjsWorker`) |
| workerd (Miniflare) | **not loadable as bundled**: the build keeps a dynamic `import()` of the worker URL, which Miniflare rejects |
| Console output | prints `Warning: Cannot polyfill Path2D` in Deno even with `verbosity: 0` |
| Size | about 525 KB gzipped with its worker module |
| Install | brings `@napi-rs/canvas` as an optional dependency, a native module (against RT-2's no-native-code rule unless callers omit optional dependencies) |

### Not covered by the spike

- Firefox and WebKit were not available in the spike environment; the PDF reader's runtime tests run them in the CI browser matrix.
- CJK text that needs predefined CMaps (`cMapUrl`) was not tested. Without CMaps such text may be missing: the PDF reader must either bundle the needed CMaps (and add them to the size budget) or report the gap with a warning.

## Result

All four checks pass for `unpdf`: (1) it runs in all the CI runtimes tested (Node 20/22/24, Bun, Deno, a Chromium browser, Workers); (2) text items carry positions and widths for the reading-order layer; (3) it is configured with no `eval`, no network and no worker; (4) its size is about 480 KB gzipped. `pdfjs-dist` legacy fails Node 20 and the Workers bundle as-is and pulls a native optional dependency, so it is not chosen.

## Consequences

- The PDF reader is the one large subpath. It is excluded from the 40 KB reader budget and gets 500 KB gzipped.
- The PDF reader bundles the engine from the exact `unpdf` devDependency. No runtime dependency is added.
- Updating `unpdf` (and so pdf.js) re-runs the checks above in the PDF reader's runtime tests.
- Found with the PDF reader (#45): loading the engine changes globals once — it sets `globalThis.DOMMatrix` (minimal polyfill, when missing), `pdfjsLib`, `pdfjsWorker` and `_pdfjsTestingUtils`, and polyfills `Map.prototype.getOrInsertComputed`, `Uint8Array.prototype.toHex` and `Math.sumPrecise` where missing. `Object.prototype` and `Array.prototype` are untouched. This is documented in `docs/formats/pdf.md`; the PDF fuzz target loads the engine before the runner's prototype baseline.
- Found by the PDF fuzz target (#45): on some malformed page trees pdf.js (both builds) leaves an internal prefetch promise rejected and unobserved during `getDocument()`; in Node this is an `unhandledRejection`. Tracked in #206.

## Page-kids prefetch patch (issue #206)

The owner approved a local patch on 2026-10-10.
Malformed unused page-tree kids can reject an unobserved prefetch promise.
Node then stops the process under its default rejection policy.

The build attaches a no-op rejection handler and retains the original promise.
Later callers still receive its original result or error.
The transform matches structure, independently of minified names.
The build fails unless each approved site matches exactly once.
Unit tests and fuzz tests use the same transform.
The hostile corpus includes the fuzz crash and a minimal synthetic PDF.
The hostile runner rejects any unhandled rejection for every format.

`THIRD_PARTY_NOTICES.md` records the Apache-2.0 and MIT licenses.
The bundled engine retains a license header and a modification notice.
Remove the patch after pdf.js and unpdf release the fix.
The owner posts the upstream report drafted on #206.

The patched PDF reader measures 490.06 KB minified and gzipped.
Its RT-5 budget remains 500 KB.
Local verification passes with Node 24, UTC, and a real macOS temporary path.
Issue #260 tracks failures with the default macOS test environment.

PDF fuzz found a separate unhandled promise in `Catalog.getPageIndex` after the first patch.
The owner approved the second patch in PR #205 on 2026-10-10.
It observes sibling promises before the method can throw for an absent outline target.
It retains each original callback promise for later awaiters.
Each built engine contains one patch in each method.
The hostile corpus retains the new CI crash and a minimal missing-outline-page PDF.
Issue #261 records the reproduction and the decision.
Merge still requires green CI, including PDF fuzz.

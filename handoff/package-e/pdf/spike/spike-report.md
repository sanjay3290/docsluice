# PDF engine throwaway runtime spike

**Status:** preparation evidence only. No repository package, lockfile, config, source, or ADR was changed. This does not satisfy the all-runtime or acceptance gates in proposed ADR 0009.

## Installation and package inspection

Installed only under `/tmp` with npm's install scripts disabled, using cache `/tmp/package-e-npm-cache`:

```sh
npm install --prefix /tmp/docsluice-pdf-spike --cache /tmp/package-e-npm-cache \
  --ignore-scripts --no-audit --no-fund --omit=optional --save-exact \
  unpdf@1.7.0 pdfjs-dist@5.6.205
npm install --prefix /tmp/docsluice-unpdf-only --cache /tmp/package-e-npm-cache \
  --ignore-scripts --no-audit --no-fund --omit=optional --save-exact unpdf@1.7.0
```

The installed candidate is exactly `unpdf@1.7.0` (MIT; no `engines` field, no `preinstall`/`install`/`postinstall` scripts). The exact comparison engine is `pdfjs-dist@5.6.205` (Apache-2.0; `engines.node: >=20.19.0 || >=22.13.0 || >=24`; no install hooks). The package-only candidate tree has no runtime dependencies; the candidate uses its bundled `unpdf/pdfjs` entry. The matching `pdfjs-dist` manifest places `@napi-rs/canvas` and `node-readable-to-web-readable-stream` in optional dependencies; they were omitted and neither was needed by text extraction. The candidate itself declares `@napi-rs/canvas` as an optional peer. Node-only rendering is outside this probe.

License note for review: the published unpdf package says MIT and includes its MIT `LICENSE`; its `dist/pdfjs.mjs` is the bundled PDF.js implementation, while the separate matching `pdfjs-dist` package is Apache-2.0. The unpdf package's top-level file listing did not contain a separate PDF.js license/NOTICE, and the minified bundle did not include the literal `Apache-2.0` text. This is a packaging/licensing review question, not a legal conclusion; do not represent the package as MIT-only without reviewing upstream notices.

## Probe and evidence

`probe.mjs` is a runnable API-only probe. It opens local original CC0 fixtures, passes bytes as `Uint8Array`, and supplies `isEvalSupported:false`, `useWorkerFetch:false`, `useWasm:false`, `disableAutoFetch:true`, `disableStream:true`. It traps global `fetch`, HTTP(S) request/get, XHR, global and Node worker constructors, global `eval`, and `Function` calls/constructors. It reads text items/geometry, annotations, labels, outline, metadata, and JavaScript action data; it never invokes a viewer or action handler. Results are saved as `unpdf-only-node24.json`, `unpdf-node24.json`, and `legacy-node24.json`.

On Node **v24.19.0**, `getResolvedPDFJS().version` for unpdf 1.7.0 was **5.6.205**, matching its tagged package and README. The package-only installation (without a separately installed `pdfjs-dist`) passed all four fixture reads. The legacy comparison reported the same engine version. In both modes all instrumented counters remained zero (`fetch`, HTTP, HTTPS, XHR, Worker, eval, Function). The action fixture's parsed JavaScript action was returned as data (`OpenAction: ["this.docsluiceMarker = 1;"]`); the marker stayed `0`. The URI link fixture returned `https://example.invalid/docsluice` as annotation metadata; no request was made. These observations cover these inputs and API paths only; they are not a general sandbox proof.

The labels/outline fixture returned three pages, labels `i`, `ii`, `A-3`, outline title `Synthetic bookmark`, and metadata title/author. The unpdf `extractTextItems` wrapper returned positioned items (`str`, `x`, `y`, `width`, `height`, `fontSize`, `fontFamily`, `dir`, `hasEOL`). Raw `page.getTextContent()` also supplies the transform needed by the private layout adapter; the convenience wrapper omits the raw transform. Its `y` values are bottom-left-origin PDF user coordinates (sample first item at x=48, y=740), so an adapter still must normalize coordinates.

The two-column fixture yielded all expected strings and usable coordinates, but raw PDF.js content-stream order was `Full width title`, `Left first`, `Right first`, `Left second`, `Right second`. The expected reading order is column-wise, so unpdf alone does not provide docsluice reading order; the separate #46 layout stage remains necessary. The image-only fixture produced no text, as expected (no OCR tested). The 100-page fixture produced 100 text items / 3,000 characters, with expected first and last page text.

Performance was a light Node 24.19.0 container measurement on an Intel Xeon Platinum 8573C (Linux x64), one warm-up followed by 10 parses of the 30,597-byte 100-page synthetic fixture. Each timed pass parsed bytes, extracted every page's text content, fetched labels/outline/metadata/action data, and cleaned pages; file reads were outside the timer. Latest unpdf package-only result: median **37.36 ms**, p95 **54.41 ms**. Latest legacy result: median **25.48 ms**, p95 **42.32 ms**. These small, unstable synthetic timings are not a PERF-1 claim or cross-engine recommendation.

## Throwaway bundle-size comparison

A bundler was available, so the shipped entrypoints were bundled with workspace `tsdown 0.23.0` / Rolldown `1.2.13`, `--no-config --format esm --platform node --minify`, writing only under this spike directory. Generated third-party bundles are excluded from the committed handoff; reproduction commands and hashes are retained. No source maps were emitted. Direct separate gzip used `gzip -9 -n`.

| Entry/chunk                               | Raw bytes | gzip bytes |
| ----------------------------------------- | --------: | ---------: |
| unpdf dynamic root `index.mjs`            |     6,977 |      2,764 |
| unpdf bundled PDF.js chunk                | 1,609,661 |    486,491 |
| pdfjs-dist legacy Node `pdf.mjs`          |   464,397 |    138,439 |
| pdfjs-dist legacy worker chunk (separate) | 1,223,528 |    377,283 |

The bundled unpdf root + PDF.js chunks total 1,616,638 raw / 489,255 gzipped bytes. Legacy `pdf.mjs` plus its separately shipped worker total 1,687,925 raw / 515,722 gzipped bytes. The legacy Node probe used PDF.js's fake-worker path; the initial size measurement did not test the browser/worker package path; later browser and Workers probes are documented separately. This is a throwaway Node 24 minified bundler comparison, not a production consumer bundle, and its target does not represent every runtime.

## Runtime coverage and blockers

At the initial checkpoint, only Node v24.19.0 was installed. Later local checks below and in the runtime-specific directories added Node 20/22, Bun, Deno, Chromium, and workerd evidence. These local probes do not replace the hosted #23 matrix. The package manifest for unpdf 1.7.0 declares no minimum Node engine, which is not proof of Node 20 support. `pdfjs-dist@5.6.205` itself declares Node >=20.19.0 (or >=22.13.0 / >=24), but that does not prove the bundled `unpdf` runtime works across docsluice's advertised floor.

Still unresolved: #23 full runtime matrix; browser/Workers behavior and worker-creation instrumentation there; actual application dependency/artifact closure; remote asset denial in every target; real corpus/goldens and PDF-10 action matrix; size under the production build; integrity/security and limits under malformed/hostile PDFs; PDF-1 reading-order accuracy; and upstream license/NOTICE review. Keep ADR 0009 Proposed and treat 1.7.0 as a bounded research candidate only.

## Additional runtime checks (official Node 20/22 binaries)

Downloaded official Node release archives from `https://nodejs.org/dist/` to `/tmp/node-official-runtimes/`, verified each archive against the matching official `SHASUMS256.txt`, and extracted only under `/tmp`:

| Runtime       | Official archive SHA-256                                           | unpdf package-only                                                                                                   | legacy pdfjs-dist |
| ------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Node v20.20.2 | `df770b2a6f130ed8627c9782c988fda9669fa23898329a61a871e32f965e007d` | all 4 prepared fixtures and 100-page fixture passed; all instrumented network/worker/eval counters 0; PDF.js 5.6.205 | same              |
| Node v22.23.3 | `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de` | all 4 prepared fixtures and 100-page fixture passed; all instrumented network/worker/eval counters 0; PDF.js 5.6.205 | same              |

The 100-page fixture produced 100 items / 3,000 chars with expected first and last page text on both versions. This expands only the local Node evidence; it does not replace the A23 project runtime matrix or production build.

## Chromium browser check

Chromium `151.0.7922.173` successfully ran the prepared byte fixtures through both unpdf 1.7.0 and legacy pdfjs-dist 5.6.205 using an ephemeral `127.0.0.1` fixture server. The page CSP was `default-src 'none'; script-src 'self' 'nonce-local-probe'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'`. Instrumented fetch, Worker, XMLHttpRequest, eval, and Function counters were all zero. Browser requests were only the page and local unpdf/pdfjs module URLs; no fixture or external asset request occurred. Both engines produced matching counts for all five fixtures, including 100 pages / 3,000 chars and image-only 0 chars. Machine-readable evidence is `chromium-loopback-result.json`; a reusable harness and run instructions are in `browser-harness.cjs` and `browser-harness.md`, with artifact hashes in `browser-artifacts.sha256`.

The initial `file://` route was blocked by the sandbox, so the harness uses loopback HTTP as the normal local browser test path. This is one local Chromium run, not the hosted browser/Workers matrix required by A23. Browser/Workers acceptance gates remain open.

## Bun, Deno and local Workers follow-up

`runtime-bun-deno/` records Bun 1.4.2 and Deno 2.9.7 runs on the same five authored cases. Both unpdf 1.7.0 and matching legacy PDF.js parsed the files. Canonical Deno `npm:unpdf@1.7.0` succeeds in a cached-only run without network or install-script permission; importing the unpdf entry directly by file URL instead fails package self-resolution, and is recorded as a harness limitation. Successful runs observed zero global network/worker/eval/Function guard calls. Bun's OS-level network isolation was unavailable, so its global traps do not prove every network API is denied.

`runtime-workers/` records the pinned official local workerd runtime with compatibility date 2026-08-03, no Node compatibility flag, no Buffer global, and an explicit denying outbound service. The five inputs matched source facts with zero global guard calls; guards run after static imports, which limits initialization coverage. The initial omitted globalOutbound setting inherited internet access; independent review found this, and the corrected configuration was rerun before publication. `runtime-review.md` contains the independent fresh validation and limits.

The research candidate now has local evidence in each requested runtime family. Hosted #23 acceptance, production subpath size/lazy-import behavior, license/NOTICE review, full action/CMap/font/security cases, and real corpus/goldens remain open. ADR 0009 stays Proposed; this handoff does not add a runtime dependency or claim #44 complete.

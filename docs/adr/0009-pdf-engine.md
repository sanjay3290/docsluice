# 0009. PDF engine: unpdf (serverless pdf.js), lazy-loaded

- Status: Proposed — confirm in the PDF spike issue
- Date: 2026-10-09
- Requirement IDs: R1, PDF-1..PDF-10, RT-1, RT-2

## Context

A PDF parser written from scratch takes years (risk R1). pdf.js is the reference engine in JavaScript. `pdfjs-dist` assumes a browser or Node worker setup. `unpdf` ships a serverless build of pdf.js that runs in Node, Deno, Bun, browsers and edge workers.

## Decision

Use `unpdf` (and its bundled pdf.js) behind docsluice's own reading-order layer and budget. Load it only through dynamic `import()` when a PDF arrives. Turn off JavaScript evaluation, font loading from the network and every remote action (PDF-10, SEC-10).

The PDF spike issue must confirm, with a written result in this ADR:

1. It runs in all six CI runtimes.
2. Text items carry positions that the reading-order layer needs.
3. It can be configured with no `eval`, no network and no worker.
4. Its size, which sets the RT-5 exception for the PDF reader.

If any check fails, the spike records the failure and proposes `pdfjs-dist` legacy build instead.

## Consequences

- The PDF reader is the one large subpath. It is excluded from the 40 KB reader budget.

## Local spike results, 2026-10-09

These results are review inputs for #44. Status stays **Proposed**: the local
experiments do not establish the complete #23 CI matrix or authorize the #45
dependency integration. The exact research candidate is `unpdf@1.7.0`, whose
bundled PDF.js reported `5.6.205`. The comparison is
`pdfjs-dist@5.6.205/legacy/build/pdf.mjs`. Both were installed in temporary tool
directories with install scripts disabled; repository dependency files did not
change. Newer unpdf 1.8.x declares Node >=22 and was excluded from this
Node-20-targeted experiment.

| Local runtime | unpdf 1.7.0 | Matching legacy PDF.js | Scope |
| --- | --- | --- | --- |
| Node 20.20.2 / 22.23.3 / 24.19.0 | Passed | Passed | Positioned text, labels, outline, URI annotation data, action marker and 100-page fixture |
| Bun 1.4.2 | Passed | Passed | Five original fixtures; global API guards only, OS network isolation unavailable |
| Deno 2.9.7 | Passed | Passed | Canonical cached-only `npm:unpdf@1.7.0`; no network or install-script permission |
| Chromium 151.0.7922.173 | Passed | Passed | Loopback module server, CSP denying connect/worker/eval paths, five byte inputs |
| workerd 1.20261009.1 | Passed | Not tested | Local unpdf bundle, no Node compatibility/Buffer, explicit deny-all outbound service |

The canonical Deno npm import needs no resolver shim. A direct file-URL import
of unpdf's `dist/index.mjs` failed package self-resolution; that separate setup
failure is not a failure of normal Deno npm package resolution. The Workers
row is local workerd evidence, not a hosted Cloudflare deployment. Firefox,
WebKit, a legacy Workers comparison and the complete project CI matrix remain
unverified.

Configuration supplied byte-only input and `isEvalSupported:false`,
`useWorkerFetch:false`, `useWasm:false`, `disableAutoFetch:true` and
`disableStream:true`; browser/Workers also disabled range loading. No remote
font, CMap, WASM or document URLs were configured. Instrumented fetch, XHR,
worker, eval and Function counters stayed zero on successful fixture runs;
Node additionally trapped HTTP(S) and Node worker constructors. The PDF
OpenAction marker remained unchanged while its script was returned as data.
These API-path observations do not prove every font/CMap/action/malformed-file
case safe. Workerd guards run after static imports, so initialization is not
covered by those counters. Its original omitted outbound policy was caught by
independent review, corrected to a denying service and rerun.

Raw text items carried six-number transforms and dimensions. The convenience
unpdf item wrapper omits the transform, so the adapter should use
`page.getTextContent()`. The private layout layer remains necessary for reading
order; these engine results do not establish reading-order accuracy.

Throwaway minified Node ESM bundles using tsdown 0.23.0 / Rolldown 1.2.13 and
deterministic `gzip -9 -n` measured 489,255 gzip bytes for unpdf root plus its
engine chunk, versus 515,722 for legacy PDF.js plus its fake-worker chunk.
These are engine-entry measurements, not the production PDF subpath or proof
of lazy loading/core bundle size. On the 30,597-byte original synthetic
100-page input (100 text items, 3,000 characters), Node 24 after one warm-up
and ten measured parses gave unpdf median 37.36 ms / p95 54.41 ms and legacy
median 25.48 ms / p95 42.32 ms. The container machine and small synthetic input
do not establish the named-machine PERF-1 acceptance target.

unpdf's package manifest is MIT, declares no engine floor or hard runtime
dependencies, and has no install hooks. Its optional native canvas peer was
omitted for text extraction. The bundled PDF.js component license/NOTICE
handling still needs review; do not describe the complete bundle as MIT-only.

### Decision remaining

Continue reviewing exact candidate 1.7.0; do not accept or supersede this ADR
until the #23 CI evidence, production subpath/lazy-import checks, bundled
license/NOTICE review and missing asset/action/security cases are resolved.
Once accepted, pin the selected version in ADR 0011 and add it only in #45.
Original fixtures, probe sources, hashes, raw results and independent runtime
review are in the separate
[package E research handoff](https://github.com/sanjay3290/docsluice/tree/handoff/package-e-research/handoff/package-e/pdf/spike).
Generated third-party bundles and temporary runtime binaries are excluded
from that handoff and can be reproduced with its commands.

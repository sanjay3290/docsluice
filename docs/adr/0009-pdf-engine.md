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

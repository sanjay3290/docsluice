# PDF engine spike (issue #44) — not for merging

Throwaway harness behind ADR 0009. It is kept on this branch only so the results can be re-run.

1. In a scratch directory: `npm install --ignore-scripts --save-exact unpdf@1.8.1 pdfjs-dist@6.4.299 rolldown@1.2.13 miniflare@4`.
2. Put test PDFs in `files/` (the spike used `corpus/pdf/{headings-outline,lists-tables,deck-12-slides,encrypted-document,scanned-image-only}.pdf` and a 100-page text PDF exported by LibreOffice from a generated `.fodt`).
3. `node node-run.mjs unpdf|legacy` (also with Node 20/22, `bun`, and `deno run --allow-read=. --deny-net`).
4. `node make-bundles.mjs` (bundles and engine sizes), `node browser-run.mjs` (Chromium with a strict CSP), `node workers-run.mjs` (workerd via Miniflare).
5. `font-check.mjs` reads a PDF that uses a non-embedded Helvetica.

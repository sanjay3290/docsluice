# PDF support

The PDF reader turns each page into a `section` with `role: 'page'`, `loc.page` (1-based) and `loc.pageLabel`. `extract()` loads it lazily for `pdf` input; it is also the `docsluice/pdf` subpath (`pdfReader`). The engine is pdf.js through `unpdf` (ADR 0009), loaded with dynamic `import()` only when a PDF arrives; `src/readers/pdf/engine.ts` is the only module that knows its API.

## Safety (PDF-10, SEC-9, SEC-10, SEC-11)

- The engine runs with `isEvalSupported: false`, no worker (in-thread), no streaming or range requests, no font, standard-font or CMap loading, no system fonts, no XFA and a 16-megapixel image cap. It never fetches anything and never generates code from strings.
- PDF JavaScript (document-level, open actions, page and annotation actions) is never run; its presence sets `features.hasJavaScript`.
- Launch, remote (`GoToR`) and non-web URI actions are never followed. They set `features.hasExternalLinks` and never appear as link targets in the output.
- Embedded files set `features.hasEmbeddedFiles` (they are not extracted yet).
- Every page counts toward the `pdfPages` limit (default 2,000); the reader stops there with `TRUNCATED`. It ticks the budget per page and per text item, and the output goes through the usual output-character and depth limits.

## Pages and text (PDF-1)

- Page labels come from the document's `/PageLabels` (decimal, upper and lower roman, letters, prefixes, start values). `loc.pageLabel` is set when a label differs from the page number.
- Text items are joined in content-stream order. A new line starts at an engine line end or a vertical jump; a new paragraph starts after a vertical gap larger than 1.6 line heights; items separated by a visible horizontal gap are separated by a space. Reading order for columns, de-hyphenation and header/footer removal arrive later (PDF-2, PDF-3), so repeated headers and footers stay in the text for now.
- With `runs: true`, text inside a web link annotation (`http`, `https`, `mailto`) becomes a run with `href`.

## Pages without a text layer (PDF-4)

A page with no visible text whose images cover at least a quarter of its area is a scanned page: its section gets `needsOcr: true`, `stats.needsOcr` is set, and one `NEEDS_OCR` warning lists the page numbers (`Pages without a text layer need OCR: 1, 4-6.`). A blank page is not flagged.

## Metadata and outline (PDF-6)

- `metadata` comes from the Info dictionary, with XMP `dc:title`/`dc:creator` as fallbacks: `title`, `authors`, `created` and `modified` (PDF dates such as `D:20260401093000+02'00'` become ISO 8601, `2026-04-01T09:30:00+02:00`; no zone gives no offset), `pageCount` and `language` (the catalog `/Lang`). With `metadata: false` authors are removed.
- Outline entries (bookmarks) become `heading` blocks at the start of their target page, in outline order, with level = outline depth + 1 (at most 6). An entry whose destination cannot be resolved opens the first page.

## Errors

- A password-protected PDF throws `EncryptedError` (`ENCRYPTED`, reason `password-required`); a wrong `password` option gives reason `wrong-password`. With the right `password` the document is read. (More encryption handling is PDF-5.)
- Bytes the engine cannot open throw `CorruptFileError` with the engine error as `cause`. A single page that fails is an empty section with `UNREADABLE_PART`.

## Limits and size

The PDF subpath is the one large reader: about 480 KB gzipped with pdf.js, budgeted at 500 KB (RT-5 exception, ADR 0009). The engine is in its own lazily loaded chunk; importing `docsluice` does not load it.

Performance: a generated 100-page text PDF (40 lines per page) extracts in about 0.3–0.5 s locally (PERF-1 target: 3 s); the test bound is 6 s.

Hostile samples in `hostile/pdf/`: a JavaScript open action plus document JavaScript (`hasJavaScript`, nothing runs), launch and remote `GoToR` links (`hasExternalLinks`, never followed), a trailer whose `/Prev` points at itself, a 100,000-page tree built from shared nodes (stops at `pdfPages` with `TRUNCATED`), and a page tree nested 2,000 deep. None makes a network call.

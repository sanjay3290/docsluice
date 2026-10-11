# PDF support

The PDF reader turns each page into a `section` with `role: 'page'`, `loc.page` (1-based) and `loc.pageLabel`. `extract()` loads it lazily for `pdf` input; it is also the `docsluice/pdf` subpath (`pdfReader`). The engine is pdf.js through `unpdf` (ADR 0009), loaded with dynamic `import()` only when a PDF arrives; `src/readers/pdf/engine.ts` is the only module that knows its API.

## Safety (PDF-10, SEC-9, SEC-10, SEC-11)

- The engine runs with `isEvalSupported: false`, no worker (in-thread), no streaming or range requests, no font, standard-font or CMap loading, no system fonts, no XFA and a 16-megapixel image cap. It never fetches anything and never generates code from strings.
- PDF JavaScript (document-level, open actions, page and annotation actions) is never run; its presence sets `features.hasJavaScript`.
- Launch, remote (`GoToR`) and non-web URI actions are never followed. They set `features.hasExternalLinks` and never appear as link targets in the output.
- Embedded files set `features.hasEmbeddedFiles` (they are not extracted yet).
- Loading the engine (once, on the first PDF) changes the global environment the way pdf.js does: it defines `globalThis.DOMMatrix` when missing (a minimal polyfill), `globalThis.pdfjsLib`, `globalThis.pdfjsWorker` and `globalThis._pdfjsTestingUtils`, and adds polyfills for `Map.prototype.getOrInsertComputed`, `Uint8Array.prototype.toHex` and `Math.sumPrecise` where the runtime lacks them. `Object.prototype` and `Array.prototype` are not changed, and nothing changes per document.
- Every page counts toward the `pdfPages` limit (default 2,000); the reader stops there with `TRUNCATED`. It ticks the budget per page and per text item, and the output goes through the usual output-character and depth limits.
- Every font the engine loads counts toward the `pdfFonts` limit (default 256), shared by all PDFs in one extraction. Past the limit the engine refuses further fonts, so their text is lost. With `onLimit: 'truncate'` the reader keeps the page in progress, adds `TRUNCATED` and stops. With `onLimit: 'throw'` it throws `LimitExceededError` (`limit: 'pdfFonts'`).
- Each CMap (ToUnicode or embedded encoding) maps at most 65,536 codes through ranges. A range past that cap is dropped, and the CMap keeps the ranges read before it. Without the cap, a 1 KB file could expand one range into 16.7 million strings (#262).

## Pages and text (PDF-1)

- Page labels come from the document's `/PageLabels` (decimal, upper and lower roman, letters, prefixes, start values). `loc.pageLabel` is set when a label differs from the page number.
- Text is laid out in reading order (PDF-2); see below. Header and footer removal arrives with PDF-3, so repeated headers and footers stay in the text for now.
- With `runs: true`, text inside a web link annotation (`http`, `https`, `mailto`) becomes a run with `href`.

## Reading order (PDF-2)

The layout code is in `src/readers/pdf/layout/`. It is a set of pure functions over the engine's text items.

- **Direction.** Items are grouped by text direction, in quarter turns. The direction with the most text is laid out first, in a frame where its text runs left to right. A page whose text runs up or down, whether it is a rotated page or text drawn rotated, reads like an upright page. Text in other quarter turns follows, laid out the same way. Skewed text comes last, one paragraph per item, in content-stream order.
- **Lines.** Items within half a font size of a row's baseline form one row. That keeps superscripts and subscripts on their line, with no space. A row splits into segments at a gap wider than 1.5 font sizes, or 0.6 font sizes when the two items are not next to each other in the content stream. A space goes between items at a gap wider than 0.2 font sizes, or where the content stream had a whitespace item.
- **Columns.** A recursive XY-cut, walked with an explicit stack and at most 32 levels deep, looks for a vertical gutter. The text on each side must look like a column: at least two lines, with a median width of at least five font sizes. Both sides must overlap vertically. Lines that cross the gutter (titles, mid-page headings, full-width figures, footnotes) split the page into bands. The bands are read from top to bottom, and each band's columns from left to right. A key-value list or a narrow table is not taken for columns.
- **Paragraphs.** A new paragraph starts at any of these:
  - a baseline step larger than 1.6 font sizes;
  - a font-size change of 20 % or more;
  - a bullet, including a symbol-font glyph in the Private Use Area;
  - a table or form row (a line split by wide gaps);
  - a first-line indent after a line that ends a sentence or stops short of the column's edge.

  A paragraph that runs on into the next column (no sentence end, then a lowercase word) stays one paragraph.
- **Hyphens.** A line-end hyphen after a letter is removed when the next line starts with a lowercase letter.
- **Right-to-left.** Items the engine marks right-to-left keep their content-stream (logical) order, and such lines read their segments from the right.
- **Headings.** Font-size headings are detected only when the document has no outline. A paragraph of at most three lines and 200 characters, set at least 1.25 times the page's body size, is a heading. The body size is the median font size by character. The level is 1 at 1.9 times the body size or more, 2 at 1.5 times or more, and 3 otherwise.
- **Determinism.** Coordinates are rounded to 1/100 pt, and every sort ends on the content-stream index, so the same items always give the same order.

**Accuracy.** `node scripts/corpus/pdf-reading-order.mjs`, run after a build, measures word order on ten hand-checked corpus pages: the two-column article, the three-column newsletter, lists and tables, notes, links, labels, headings and a slide. The result is 1,358 of 1,358 words in order, and all 10 pages are exact. This is the start of QA-7.

**Known gaps.**

- Two column sections stacked with no line between them read as one pair of columns.
- Text tables read row by row only when their cells are short; tables are PDF-8.

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

Hostile samples in `hostile/pdf/`: a JavaScript open action plus document JavaScript (`hasJavaScript`, nothing runs), launch and remote `GoToR` links (`hasExternalLinks`, never followed), a trailer whose `/Prev` points at itself, a 100,000-page tree built from shared nodes (stops at `pdfPages` with `TRUNCATED`), a page tree nested 2,000 deep, ToUnicode ranges that claim 16.7 million codes (alone, twice, and shared by four fonts), 512 ranges past the CMap cap, and 300 fonts on one page (stops at `pdfFonts` with `TRUNCATED`). None makes a network call.

## Engine patch

The PDF reader bundles a patched pdf.js from the exact `unpdf` 1.8.1 devDependency.
It adds no runtime dependency.
The build observes unused page-kids and page-index prefetch rejections and retains each original promise.
The build fails unless each patch site matches exactly once.
The build also caps CMap ranges and counts loaded fonts (#262); see Safety above.
The patch prevents the Node process crash recorded in #206.
The hostile corpus includes the fuzz crash and a minimal synthetic PDF.
Both package entries pass a separate process test under Node's default rejection policy.
License texts ship in `dist/THIRD_PARTY_NOTICES.md`.

The owner approved a second patch for outline page resolution (#261).
It observes sibling promises when an outline target is absent from its parent's kids.
Both fuzz crash inputs and both minimal regressions pass the hostile runner.

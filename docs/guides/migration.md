# Migrating extraction to docsluice

Keep your existing extraction path behind a feature flag while comparing the same licensed files. Check text, tables, order, locations, attachments, warnings and truncation before switching. docsluice's document model is an extraction contract; it does not replace spreadsheet editing, HTML styling or archive writing.

The runnable example is [`packages/docsluice/examples/migration/ingest.ts`](../../packages/docsluice/examples/migration/ingest.ts). `ingestForModel(bytes, filename)` makes one `extract()` call, supplies shared limits, disables personal metadata, extracts nested files and applies a content redaction policy before rendering Markdown. It returns the document, Markdown and block locations for citations. Installed applications import `extract`, `toMarkdown` and the types from `docsluice`; the checked-in example imports the repository source so its tests exercise the same implementation without an installed release.

The example masks email addresses and US-style ID numbers in paragraphs, list items, tables and visible labels. It removes inline runs and stored cell values/formulas so split runs or unformatted values cannot reintroduce masked content; that deliberately gives up inline formatting and raw-value access. Replace that policy with your application's requirements. Location paths and sheet names remain citation identifiers; this example does not promise anonymization of every document field. `metadata: false` removes personal metadata, while `transform` changes content. Review child documents and their statuses before sending attachment content onward. Rendering the root Markdown is separate from rendering each extracted child.

## Option and behavior mappings

| Existing operation | docsluice operation | Difference to check |
| --- | --- | --- |
| SheetJS `read` then `sheet_to_json` or `sheet_to_csv` | `extract` with a filename hint; inspect sheet sections and table cells | Cells carry displayed text, optional raw values and addresses. Domain row objects are an application projection, not the returned document shape. |
| SheetJS raw/formatted value selection | `cell.text` versus `cell.raw`; `formulas: true` for formula text | Formula text is not evaluated. Check dates, merged/sparse cells and hidden sheets with your fixtures. |
| mammoth `extractRawText` or `convertToHtml` | `toText` or `toMarkdown` on the extracted document | A mammoth style map or image converter has no direct option mapping; inspect headings, links, images and notes instead of expecting identical HTML. |
| pdf-parse text extraction | `extract` then `toText`/`toMarkdown`; inspect page sections and locations | Reading order and page labels can differ. Check `stats.needsOcr`; a scanned page needs an OCR stage rather than an assumed text layer. |
| pdf-parse password option | `password` in extraction options | Supply secrets through your application; do not place them in logs or filenames. Exact unsupported/encrypted outcomes depend on the registered reader. |
| adm-zip entry enumeration / yauzl `entry` events | `children: 'list'` and document children | Child statuses distinguish listed, extracted and failed entries; sanitized paths are identifiers. This API does not extract files to disk. |
| Reading each ZIP entry yourself | `children: 'extract'` | Nested extraction shares byte, depth, output and time budgets with the root; a separate budget per entry would change the safety model. |
| Skipping attachments | `children: 'skip'` | The current core omits child records in this mode; an empty child list does not prove no attachment exists. |
| Per-library timeout or input-size checks | `limits`, `signal`, `onLimit` and `strict` | Limit truncation is observable in warnings/stats. Input-byte and compression-ratio breaches throw; `onLimit: 'throw'` changes other limit handling. |

Check the versions you currently use. pdf-parse has both older function-style releases and newer `PDFParse` class releases, so a single old option map does not cover every version. Primary references: [SheetJS array utilities](https://docs.sheetjs.com/docs/api/utilities/array/), [mammoth API](https://github.com/mwilliamson/mammoth.js), [pdf-parse API](https://github.com/mehmet-kozan/pdf-parse), [adm-zip API](https://github.com/cthackers/adm-zip), and [yauzl API](https://github.com/thejoshwolfe/yauzl). These are API references, not claims that one library is universally faster or safer.

## Rollout checks

Treat the filename as a hint: detection uses content. Keep warnings and failed-child statuses in your application telemetry without recording document text. Verify the required format's reader is registered, test oversize and aborted uploads, and decide how partial output should be handled. Preserve `loc` when indexing content so a citation can refer to a page, slide, sheet range or archive path.

Run the checked-in example tests with `npm test --workspace packages/docsluice -- test/docs/migration.test.ts`. They execute the ingestion example with the currently registered legacy DOC reader and test the content policy with synthetic blocks. At this base, DOCX, XLSX, PDF and ZIP container readers are still pending integration. Their migration acceptance fixtures and all reader-specific option semantics must be checked before claiming those migration paths complete. No examples silently substitute a mock reader for those formats.

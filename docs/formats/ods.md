# ODS

The ODS reader (`docsluice/ods`) reads OpenDocument spreadsheets with the same output as [XLSX](xlsx.md): one `sheet` section per `table:table` in `office:spreadsheet`, holding one table per region of value cells. It reuses the XLSX sparse sheet model and region splitter, so the two formats give the same tables, addresses, merges, limits and warnings. `test/readers/ods/parity.test.ts` checks this on the LibreOffice XLSX and ODS exports of the same workbooks.

## Cells

- **Text** is the displayed text the application saved: the cell's `text:p` paragraphs joined with line breaks, with `text:s` (spaces, at most 1,024 per element), `text:tab` and `text:line-break`. Annotations (`office:annotation`) and tables nested in a cell are not part of the text.
- **Raw values** follow `office:value-type`. `float`, `percentage` and `currency` give the number in `office:value`. `boolean` gives `true` or `false`. `date` and `time` give the ISO `office:date-value` or `office:time-value` string, which is what ODS stores; XLSX gives a date serial number instead. `string` cells have no raw value.
- A cell without paragraphs shows its typed value: the number in General format, `TRUE`/`FALSE`, the ISO date or time, or `office:string-value`.
- **Formulas** are never evaluated. A formula cell shows its cached value. Without one (no `office:value-type`) it is empty and counted in the same `UNREADABLE_PART` warning as XLSX. With `formulas: true`, `table:formula` is kept as an A1 formula: `of:=SUM([.A1:.B2])` becomes `=SUM(A1:B2)` and `[$Other.A1]` becomes `Other!A1` (best effort).
- **Merges**: `table:number-columns-spanned` and `table:number-rows-spanned` become `colSpan`/`rowSpan`, as XLSX merges do. `table:covered-table-cell` content is ignored.
- **Hidden sheets**: `table:display="false"` on the table or on its table style (`style:table-properties`) sets the section's `hidden`. ODS has no "very hidden" state. Hidden rows and columns are not marked, as in XLSX today.

Attributes are matched by namespace, not by prefix, so documents that bind other prefixes read the same.

## Repeated rows and cells

`table:number-rows-repeated` and `table:number-columns-repeated` can claim the whole 1,048,576 × 16,384 grid in a few bytes:

- Empty repeated rows and cells only move the row and column counters. Nothing is allocated.
- Value cells are stored once per position and charged to `cells`. Copies made by a repeat are capped at 65,536 per workbook. Further copies, and every cell after the `cells` limit, are counted arithmetically, never visited. They are reported in the sheet's `TRUNCATED` warning and charged to `cells`, so `onLimit: 'throw'` refuses a file that claims more cells than the limit.
- Content past row 1,048,576 or column 16,384 is ignored. Counts that are not positive decimal numbers are read as 1.
- A merge is kept for the cell as written, not for each repeated copy.

## Package

- `META-INF/manifest.xml` with `manifest:encryption-data` throws `EncryptedError`, as do encrypted ZIP entries.
- `meta.xml` gives the metadata (see [odf.md](odf.md)).
- `Basic/` or `Scripts/` entries set `hasMacros` with a `MACROS_PRESENT` warning. Macros are never run. `Object …` and `ObjectReplacements/` entries set `hasEmbeddedFiles`. A link with a URI scheme sets `hasExternalLinks`.
- `content.xml` is read with the bounded SAX tokenizer, so `xmlDepth`, `totalUncompressedBytes` and time limits apply. A missing `content.xml` gives an empty document with an `UNREADABLE_PART` warning. Duplicate part names are not read.

Not supported: hidden rows and columns, comments (annotations), named ranges, charts, data pilot tables, linked sheets (`table:table-source`) and flat `.fods` files.

## Corpus and generators

`corpus/ods` holds LibreOffice exports of the XLSX corpus workbooks. The four `workbook-*` files come from the same `.fods` sources as their XLSX and XLS versions. `cell-types`, `formulas` and `number-formats` are converted from the XLSX files. On those three, LibreOffice recalculates formulas and stores the ISO date text cell as a number, so a few cells differ from the XLSX goldens. `scripts/hostile/generate-ods.mjs` writes `hostile/ods`.

# XLSX support

The XLSX reader turns every sheet of a SpreadsheetML workbook (`.xlsx`, `.xlsm`, `.xltx`, `.xltm`; Transitional and Strict namespaces) into a `section` with `role: 'sheet'`, in workbook order (XLS-1). Each section holds `table` blocks for the sheet's cells. `extract()` loads the reader lazily for `xlsx` input; it is also the `docsluice/xlsx` subpath (`xlsxReader`). Package parts, relationships, document properties and feature flags come from the shared OOXML helpers (see [ooxml.md](ooxml.md)).

## Sheets (XLS-1)

- Order comes from `workbook.xml` `sheets/sheet`, resolved through the workbook relationships, never from part names.
- The section `title` and `loc.sheet` are the sheet name; `loc.path` is the worksheet part. Hidden sheets have `hidden: true`, very hidden sheets `hidden: 'very'`; both are extracted.
- Chart sheets and dialog sheets give an empty section. A sheet whose part is missing gives an empty section and `UNREADABLE_PART`.

## Cells (XLS-2, XLS-7)

- Shared strings (`sharedStrings.xml`), inline strings (`t="inlineStr"`) and rich-text runs are resolved to plain text. Phonetic runs (`rPh`) are reading aids and are skipped.
- Numbers keep the stored value in `raw` and show the value a person sees (XLS-3): the cell's style (`s`) selects a `cellXfs` entry in `styles.xml`, whose `numFmtId` is a custom `numFmts` code or a built-in code (ids 0–49). Dates and times use the workbook's date system (`workbookPr date1904`), including the 1900 system's fictitious 1900-02-29. Percentages, currency, thousands separators, decimals, fractions, scientific notation, sections, conditions and text sections are applied by the number-format engine described in [xlsx-numfmt.md](xlsx-numfmt.md). Output never depends on the host locale or time zone (DET-1); month and day names are English.
- General (and any format that cannot be read) shows up to 15 significant digits, so `0.30000000000000004` shows `0.3`; exponents are written `1E+21`.
- Text cells keep their text unless their format has a text section (`"text: "@`); then `text` is the formatted value and `raw` the stored text.
- Booleans show `TRUE`/`FALSE` with a boolean `raw`. Errors (`#N/A`), formula string results (`t="str"`) and ISO dates (`t="d"`) show the stored text.
- Formulas are never calculated: a formula cell shows its cached value. Formula text is not returned yet.
- Every grid cell, including empty and merged placeholders, has its `address` (`B7`). Each table has `loc.sheet` and `loc.range` (`A1:C7`), so a cell's citation is `Sheet!B7`.
- A shared-string index that does not exist gives an empty cell and one `UNREADABLE_PART` per workbook.

## Used range, sparse sheets and merges (XLS-5)

- Only cells with a value are stored, in maps keyed by row and column. `dimension` is ignored, and cells with only a style are not values.
- The used range is the bounding box of value cells. It becomes one table when it has at most 10,000 grid cells, or when at least one grid cell in four holds a value. Otherwise it is split: rows with values form bands of adjacent rows, and within each band the columns with values form groups of adjacent columns; each band and group is one table. A sheet with values in A1 and Z90000 gives two one-cell tables, not 2.3 million cells.
- Tables follow the grid convention: `rows[r][c]` is grid column `c` of the table's range. Empty grid cells are `{ text: '' }` with their address.
- A merged range belongs to the table that holds its top-left cell and is clipped to that table. The top-left cell gets `rowSpan`/`colSpan`; the cells it covers become empty placeholders (a value stored under a merge is not shown, as in Excel). Merges whose top-left cell is outside every table, and merges that overlap an earlier merge, are ignored, so a merge cannot widen the output.
- Header rows are not detected yet: `headerRows` is 0.

## Limits (XLS-6, SEC-12)

- Value cells are charged to the shared `cells` budget as they are read; the empty placeholders of each table row are charged before the row is kept. When the budget runs out, the rest of the sheet is counted, not stored, and later sheets keep their (empty) sections.
- A sheet that lost cells gets a `TRUNCATED` warning with counts only: `Sheet 2: kept 5 rows and 81920 cells; skipped 1996 rows and 32686081 cells.` Skipped counts include grid cells of tables that were cut and value cells that were never stored. With `onLimit: 'throw'` the reader throws `LIMIT_EXCEEDED` instead.
- The shared-string table holds at most `cells` items; more items are skipped with `TRUNCATED`. Its text, like all XML text, is bounded by `outputChars`.
- Sheet names, relationship ids and references from the file live in `Map`s and arrays, never as object keys.

Performance: a 50,000-row, 200,000-cell workbook (a 6.7 MB worksheet part) extracts in about 2.0–2.3 s on a development machine (target: under 3 s); the test bound is 6 s for loaded CI runners. Most of the remaining time is in the XML tokenizer and in block copying: the builder copies each table when it is emitted, again when its sheet section closes, and again at the end (#182).

Hostile samples in `hostile/xlsx/`: a sheet claiming the full 1,048,576 × 16,384 grid through `dimension` and one merge (one cell out), values in the four corners of the grid (four one-cell tables), three million shared strings in a small archive (`LIMIT_EXCEEDED` from the compression-ratio check), and prototype-named sheets, relationship ids and references (inert; one `UNREADABLE_PART`), and number-format oddities: a 3,000-character code, nested brackets, a huge elapsed serial, 400-digit exponents and 300-digit fractions, prototype-named format ids and style indexes past the end (General fallbacks, no warnings).

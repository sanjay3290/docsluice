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
- Formulas are never calculated (XLS-4, SEC-11): a formula cell shows the cached value saved in the file. A formula cell saved without a cached value is empty, and the sheet gets one `UNREADABLE_PART` warning with the count.
- With `formulas: true`, `Cell.formula` holds the formula text with a leading `=` (`=A1+B1`); array formulas are written `{=…}` on the range's first cell. Shared formulas (`t="shared"`) store the text once, on the first cell; each dependent gets that text with its relative A1 references moved by the dependent's offset (`=A2*$B$1` → `=A3*$B$1`), as Excel shows it. Strings, quoted sheet names, function names (`LOG10(`) and sheet prefixes are not moved; whole-row and whole-column references (`1:1`, `A:A`) are left as written, and a reference moved off the grid becomes `#REF!`. A dependent whose first cell is missing has no formula text.
- Every grid cell, including empty and merged placeholders, has its `address` (`B7`). Each table has `loc.sheet` and `loc.range` (`A1:C7`), so a cell's citation is `Sheet!B7`.
- A shared-string index that does not exist gives an empty cell and one `UNREADABLE_PART` per workbook.

## Used range, sparse sheets and merges (XLS-5)

- Only cells with a value are stored, in maps keyed by row and column. `dimension` is ignored, and cells with only a style are not values.
- The used range is the bounding box of value cells. It becomes one table when it has at most 10,000 grid cells, or when at least one grid cell in four holds a value. Otherwise it is split: rows with values form bands of adjacent rows, and within each band the columns with values form groups of adjacent columns; each band and group is one table. A sheet with values in A1 and Z90000 gives two one-cell tables, not 2.3 million cells.
- Tables follow the grid convention: `rows[r][c]` is grid column `c` of the table's range. Empty grid cells are `{ text: '' }` with their address.
- A merged range belongs to the table that holds its top-left cell and is clipped to that table. The top-left cell gets `rowSpan`/`colSpan`; the cells it covers become empty placeholders (a value stored under a merge is not shown, as in Excel). Merges whose top-left cell is outside every table, and merges that overlap an earlier merge, are ignored, so a merge cannot widen the output.
- Header rows are described under XLS-8 below.

## Header rows (XLS-8)

The `headerRow` option sets each table's `headerRows`. It applies to every spreadsheet reader: XLSX, XLSB, XLS and ODS.

- `'auto'` (the default) marks the first row as a header when all of these hold: it holds only text, at least half of its columns have a label, and a labelled column holds a number, date or boolean in one of the next 20 rows. A table of text only, a first row with numbers (years as column labels), and a title cell over numbers get no header, because nothing tells a label from a value. An Excel table (below) uses its own `headerRowCount`.
- `true` marks the first row of every table; `false` marks none.
- Markdown renders a header row as the table head. `toRecords(table)` (see [rendering.md](../rendering.md)) uses it for keys.

## Comments, Excel tables and defined names (XLS-9)

- **Comments.** Cell comments become `note` blocks with `role: 'comment'` after the sheet's tables. That covers legacy comments (`comments*.xml`, called notes in current Excel) and threaded comments with their replies (`threadedComments/*.xml`). `loc.range` is the cell (`B2`), `loc.sheet` the sheet and `loc.path` the comments part. A threaded comment's author comes from the workbook person list; a legacy comment's author from its `authors` list. Authors are personal data: `metadata: false` removes them. Excel writes a legacy copy of every threaded comment for older versions; that copy is skipped. Phonetic runs are not text. Comment text is cut at 32,768 characters.
- **Excel tables.** Excel tables (ListObjects, `tables/table*.xml`) are named by their `displayName`.
- **Defined names.** A defined name is used when it is exactly one range on one sheet (`Data!$A$1:$C$4`, `'It''s'!B2`). Built-in names (`_xlnm.Print_Area` and similar), hidden names, constants, formulas, several areas and `#REF!` names are left out.
- **How names reach the output.** A table or name whose range is exactly one of the sheet's tables (see XLS-5) becomes that table's `caption`. Any other one becomes an extra `table` block after the sheet's tables, with the name as its `caption`, clipped to the cells in use. Its cells are charged to the `cells` budget again, so names cannot multiply the output for free. A range outside the cells in use gives nothing. Excel tables come first, in the sheet's relationship order, then names in workbook order.

## Hidden rows and columns (XLS-10)

Hidden rows (`row hidden="1"`) and hidden columns (`cols/col hidden="1"`) stay in the output, because they often hold the data. Every cell in them, including empty placeholders, has `hidden: true`. The XLS, XLSB and ODS readers do not flag hidden rows and columns yet (#231).

## Limits (XLS-6, SEC-12)

- Value cells are charged to the shared `cells` budget as they are read; the empty placeholders of each table row are charged before the row is kept. When the budget runs out, the rest of the sheet is counted, not stored, and later sheets keep their (empty) sections.
- A sheet that lost cells gets a `TRUNCATED` warning with counts only: `Sheet 2: kept 5 rows and 81920 cells; skipped 1996 rows and 32686081 cells.` Skipped counts include grid cells of tables that were cut and value cells that were never stored. With `onLimit: 'throw'` the reader throws `LIMIT_EXCEEDED` instead.
- The shared-string table holds at most `cells` items; more items are skipped with `TRUNCATED`. Its text, like all XML text, is bounded by `outputChars`.
- Sheet names, relationship ids and references from the file live in `Map`s and arrays, never as object keys.

Performance: a 50,000-row, 200,000-cell workbook (a 6.7 MB worksheet part) extracts in about 2.0–2.3 s on a development machine (target: under 3 s); the test bound is 6 s for loaded CI runners. Most of the remaining time is in the XML tokenizer and in block copying: the builder copies each table when it is emitted, again when its sheet section closes, and again at the end (#182).

Hostile samples in `hostile/xlsx/`: a sheet claiming the full 1,048,576 × 16,384 grid through `dimension` and one merge (one cell out), values in the four corners of the grid (four one-cell tables), three million shared strings in a small archive (`LIMIT_EXCEEDED` from the compression-ratio check), prototype-named sheets, relationship ids and references (inert; one `UNREADABLE_PART`), 8,000 defined names (prototype-named, on one range or the whole grid), 16,500 hidden-column entries, 4,000 notes with prototype authors and an Excel table named `__proto__` over the whole grid (`names-comments-floods.xlsx`; inert, each name's table charged to `cells`), and number-format oddities: a 3,000-character code, nested brackets, a huge elapsed serial, 400-digit exponents and 300-digit fractions, prototype-named format ids and style indexes past the end (General fallbacks, no warnings).

## Macro-enabled files

`.xlsm` files are detected by their macro-enabled main content type and reported with their own format id (`xlsm`), and are read by this reader with the same blocks as the plain version. A VBA project part (`vbaProject.bin`) sets `features.hasMacros` and adds one `MACROS_PRESENT` warning. Macros are never parsed, extracted or run (SEC-11). `corpus/xlsx/workbook-values-formulas-macros.xlsm` is made by `scripts/corpus/make-macro-enabled.mjs`.

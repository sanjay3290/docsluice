# XLSB

The XLSB reader (`docsluice/xlsb`) reads Excel binary workbooks ([MS-XLSB]) with the same output as [XLSX](xlsx.md): one `sheet` section per `BrtBundleSh` in workbook order, holding one table per region of value cells. It builds the XLSX sparse sheet model and reuses its region splitter, number formatter and limits, so XLSB, XLSX and [XLS](xls.md) give the same tables. `test/readers/xlsb/parity.test.ts` checks this on the XLSB versions of the XLSX corpus workbooks.

## What is read

- **Package**: the ZIP and relationships are read like XLSX: `workbook.bin` from the `officeDocument` relationship, then `sharedStrings.bin`, `styles.bin` and each worksheet part through the workbook relationships. Document properties come from `docProps`, and macros (`vbaProject.bin`), external links and embedded files set `features`, as in XLSX.
- **Records**: each record has a one- or two-byte type and a one- to four-byte size ([MS-XLSB] 2.1.4). A size that runs past its part stops that part with an `UNREADABLE_PART` warning; what was read before is kept.
- **Sheets**: the `BrtBundleSh` state gives `hidden` (`true` for hidden, `'very'` for very hidden). Chart, dialog and macro sheets, and module sheets without a part, are empty sections.
- **Cells**: `BrtCellIsst` (shared strings), `BrtCellSt`, `BrtCellRk`, `BrtCellReal`, `BrtCellBool`, `BrtCellError` and the formula records `BrtFmlaNum`, `BrtFmlaString`, `BrtFmlaBool` and `BrtFmlaError`, which give their cached value. The undocumented short cell records (types 12 to 18), which leave out the column and follow the previous cell, are read too. Blank cells hold formatting only.
- **Number formats**: `BrtFmt` custom codes and the `iFmt` of each cell XF after `BrtBeginCellXFs`, with the built-in format table; `BrtWbProp` gives the 1904 date system.
- **Merges**: `BrtMergeCell` ranges become `colSpan`/`rowSpan` like XLSX merges.

Formulas are never evaluated or decoded: the `formulas` option has no formula text for XLSB. A shared-string index past the table gives an empty cell and one `UNREADABLE_PART` warning.

## Safety

- No buffer is sized from a record field: record sizes and string lengths are checked against the bytes present.
- Cells past row 1,048,576 or column 16,384 are ignored. Stored cells are charged to `cells`; past the limit they are counted, not stored. Merges are capped at the `cells` limit.
- Every record ticks the shared time and abort budget; parts are bounded by `totalUncompressedBytes` and the compression-ratio limit.

## Corpus and generators

LibreOffice reads XLSB but cannot write it. `scripts/corpus/make-xlsb.mjs` writes the four `corpus/xlsb` workbooks from the specification, converting the cells, shared strings, formats, merges, sheet states and date system of the matching `corpus/xlsx` files; LibreOffice 24.2 imports them with the same values. Formula cells store their cached value as a constant formula. `scripts/hostile/generate-xlsb.mjs` writes `hostile/xlsb`.

## Header rows (XLS-8)

Tables get `headerRows` from the `headerRow` option, guessed the same way as for XLSX (see [xlsx.md](xlsx.md#header-rows-xls-8)). ## Hidden rows and columns, comments, tables, names (XLS-9, XLS-10)

- `BrtRowHdr` with `fDyZero` and `BrtColInfo` with `fHidden` mark their cells `hidden: true`.
- Comment parts (`commentsN.bin`: `BrtCommentAuthor`, `BrtBeginComment`, `BrtCommentText`) become `note` blocks after the sheet's tables, as in XLSX.
- Table parts (`BrtBeginList`: range, header row count, display name) and `BrtName` records with one 3-D area or cell, resolved through `BrtExternSheet`, caption the regions they cover exactly.
- `scripts/corpus/make-xlsb.mjs` carries all of these over from the XLSX corpus. `workbook-comments-hidden-names.xlsb` gives the same blocks as its XLSX source.

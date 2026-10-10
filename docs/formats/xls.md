# Excel 97–2003 workbooks (XLS)

The XLS reader (`docsluice/xls`, detected from a compound file with a `Workbook` stream) reads BIFF8 workbooks, as written by Excel 97 to 2003 and by LibreOffice. It gives the same output as the [XLSX reader](xlsx.md): one `section` with role `sheet` per sheet, in workbook order, with `hidden` set for hidden and very hidden sheets. Each sheet's tables come from the same region logic, number formats, merges and limits. `test/readers/xls/parity.test.ts` checks that the LibreOffice XLS and XLSX exports of the four corpus workbooks give the same sheets, tables and warnings.

## What is read ([MS-XLS])

- **Globals.** `BOUNDSHEET8` (name, visibility, sheet type and stream offset), `SST` with its `CONTINUE` records, `FORMAT`, `XF` and `DATEMODE` (the 1904 date system).
- **Cells.** `LABELSST`, `LABEL`, `RSTRING`, `NUMBER`, `RK`, `MULRK`, `BOOLERR` (booleans and error values such as `#DIV/0!`), and the cached result of `FORMULA` cells, with the following `STRING` record for text results. Formulas are never calculated. A formula cell without a usable cached value is empty and counted in the sheet's `UNREADABLE_PART` warning, as in XLSX.
- **Formats.** A cell's `XF` gives its number format: a custom `FORMAT` code, or a built-in id from the same locale-independent table the XLSX reader uses.
- **Merges.** `MERGECELLS` ranges.
- **Features.** A `_VBA_PROJECT_CUR` storage, macro sheets and VBA module sheets set `hasMacros`. `MBD…` storages (embedded objects) set `hasEmbeddedFiles`.

Strings follow the BIFF8 rules: 8-bit characters are Latin-1 (the low byte of UTF-16), and 16-bit characters are UTF-16. When a string is split across `CONTINUE` records, each continuation starts with a new high-byte flag. Rich-text runs and phonetic data are skipped.

## Limits and safety

- Records are read one at a time from the `Workbook` stream. A record that claims more than 8,224 bytes or runs past the stream ends that substream with `UNREADABLE_PART`, and the data read before it is kept.
- The SST's declared string count is only an upper bound: reading stops when its data runs out. A `LABELSST` index past the strings gives an empty cell and one warning.
- Sheet offsets must point at a worksheet `BOF`. Each offset is parsed once, so repeated offsets cannot multiply the work. Sheets count as archive entries.
- Cells are charged to the `cells` limit and grid positions follow BIFF8's 65,536 rows and 256 columns.
- `FILEPASS` (an encrypted workbook, including Excel's default "VelvetSweatshop" protection) throws `EncryptedError`. The reader never decrypts.

## Not supported

- BIFF5 and older workbooks (Excel 95 and earlier, stream `Book`): reported with `UNREADABLE_PART` and no content.
- Formula text: the `formulas` option has no effect, because BIFF8 stores formulas as parsed tokens, and these are not decompiled.
- Document properties (`\x05SummaryInformation`), so XLS metadata is empty where XLSX fills `language` and similar fields.
- Charts, drawings, comments, hyperlinks and hidden rows and columns.

## Header rows (XLS-8)

Tables get `headerRows` from the `headerRow` option, guessed the same way as for XLSX (see [xlsx.md](xlsx.md#header-rows-xls-8)). Hidden rows and columns, comments and named ranges are not read yet (#231).

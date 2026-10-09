# OpenDocument Spreadsheet (ODS)

The ODS reader walks `content.xml` in workbook order and emits each sheet as a
`sheet` section containing one sparse table. Cell addresses use the sheet name
and A1 notation. Stored numeric, boolean, date and string values are retained
as `raw` values where available; paragraph text is the displayed value. Formula
text is retained only when `formulas: true`; formulas are never evaluated.

Repeated empty rows and cells advance their coordinates without creating output
cells. Repeated populated cells expand only after the shared `cells` budget
accepts them. Merged anchors retain their row and column spans, and covered
cells only advance the column position. Hidden rows and columns remain included
and mark their cells `hidden`; hidden sheets remain included and emit a
`HIDDEN_CONTENT` warning. Sheet sections preserve visibility with `hidden:
true` for hidden sheets and `hidden: false` for visible sheets. Hidden sheets
are included by default and remain included with `includeHidden: true`.

Encrypted ODF manifests are rejected with `ENCRYPTED`; the reader does not
decrypt. External image and hyperlink targets are data only and are never
fetched. Macro presence is reported without running the content. Optional ODF
metadata is read from `meta.xml` and respects `metadata: false`.

The checked-in ODS files under `hostile/ods/` are hand-made clean-room inputs
for repeated empty and populated rows. They are not LibreOffice fixtures and
are not golden-output references. XLSX parity goldens remain pending the XLSX
reader/corpus integration.

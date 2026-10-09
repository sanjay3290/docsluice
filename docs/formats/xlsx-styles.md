# XLSX styles lookup

The XLSX reader loads the styles part through its workbook relationship and
`parseStylesXml(bytes, budget, warnings, loc?)` resolves each cell style index to
the number-format code referenced by `styles.xml`. It reads only direct children in
the SpreadsheetML namespace, custom `<numFmt>` records, `<cellStyleXfs>`, and
`<cellXfs>` in document order. Other style components are ignored by this
number-format helper. Built-in IDs use `builtInNumberFormat`; absent, reserved,
unknown, or invalid cell style indexes resolve to `General`.

When a cell XF explicitly sets `applyNumberFormat="false"` or `"0"`, its
number format comes from the referenced `cellStyleXfs` record (`xfId`). When
the flag is absent, the cell XF's `numFmtId` is used; if it is absent, the
referenced base XF is used when available. An explicit true flag applies the
cell XF's format. An invalid base index makes the style part unreadable.
Boolean values accept the XML forms `true`, `false`, `1`, and `0`.

The XML scanner counts elements, text nodes, attributes, and their text lengths
while building the style tree. It stops with a typed limit error before retaining
source beyond 100,000 objects or 20,000,000 code units. Those source caps are
independent of the caller's output-character quota. The helper then traverses
the bounded tree iteratively before retaining style mappings. It retains at
most 100,000 style XFs and custom number formats; custom format codes longer
than the formatter's 2,048-code-unit limit is not retained, warns once, and
resolves to `General` for styles that reference it.
Other malformed styles produce one generic `UNREADABLE_PART` warning and return
`General` for all lookups. The warning never includes file content. Cancellation
and time-budget errors propagate from `Budget.tick()`.

The reader applies the resolved code to numeric cells and text-section formats
to string cells while preserving `raw`. It reads `workbookPr/@date1904` to select
the date system. This remains a private reader helper: it does not retain
fonts/fills/borders or change the public document model. The test fixture
`packages/docsluice/test/readers/xlsx/fixtures/styles/libreoffice-styles.xml`
is the styles part extracted from a self-authored, CC0-licensed workbook saved
with LibreOfficeDev; its license sidecar records the source.

OOXML format records describe an XF in `cellStyleXfs` or `cellXfs`; the
`xfId` on a cell XF indexes `cellStyleXfs`, and `applyNumberFormat` indicates
whether that XF's number format should apply. See Microsoft's
[CellFormat / SpreadsheetML XF documentation](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellformat?view=openxml-3.0.1).

The reader integration has a 421-case LibreOffice source workbook comparison,
plus direct 1900/1904, style-index fallback and output-staging tests. Early
1900-system dates and underscore width-padding are explicitly excluded from the
LibreOffice comparison; Excel date serial 60 remains covered by the formatter's
separate compatibility test.

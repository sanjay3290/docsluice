# XLSX styles lookup

`parseStyles(root, budget, warnings, loc?)` resolves a cell style index to the
number-format code referenced by `styles.xml`. It reads only direct children in
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

The helper traverses the already-tokenized XML tree iteratively and counts
elements, text nodes, and attributes before retaining style mappings. It stops
at 100,000 source objects or 20,000,000 source text code units. It retains at
most 100,000 style XFs and custom number formats; custom format codes longer
than the formatter's 2,048-code-unit limit is not retained, warns once, and
resolves to `General` for styles that reference it.
Other malformed styles produce one generic `UNREADABLE_PART` warning and return
`General` for all lookups. The warning never includes file content. Cancellation
and time-budget errors propagate from `Budget.tick()`.

This is a private reader helper. It does not interpret styles for rendering,
parse workbook relationships, retain fonts/fills/borders, or change the public
document model. The test fixture
`packages/docsluice/test/readers/xlsx/fixtures/styles/libreoffice-styles.xml`
is the styles part extracted from a self-authored, CC0-licensed workbook saved
with LibreOfficeDev; its license sidecar records the source.

OOXML format records describe an XF in `cellStyleXfs` or `cellXfs`; the
`xfId` on a cell XF indexes `cellStyleXfs`, and `applyNumberFormat` indicates
whether that XF's number format should apply. See Microsoft's
[CellFormat / SpreadsheetML XF documentation](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellformat?view=openxml-3.0.1).

This parser validates the styles mapping layer only. It does not complete XLS-3
or XLSX reader acceptance.

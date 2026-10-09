# Legacy Excel workbooks (BIFF8)

The XLS reader handles the BIFF8 `Workbook` or `Book` stream inside an OLE
compound file. It emits worksheet sections in `BoundSheet8` order, keeps hidden
and very-hidden sheets marked as hidden, and turns supported cell records into
sparse addressed tables, coalescing matching horizontal runs in adjacent rows.
It supports shared and inline labels,
numbers, RK/MULRK values, booleans, errors, merged anchors, cached formula
results, BIFF number formats, and the 1904 date system. Formulas are never
evaluated; an expression is included only when the formula option is enabled
and the token sequence uses the reader's small literal/operator subset.
Cached `STRING` values that continue into a following `CONTINUE` record are
currently reported as unreadable; SST continuation records are supported.

The reader rejects encrypted workbooks with `EncryptedError`. BIFF5 and older
are unsupported. Chart and macro-sheet substreams are not emitted as worksheet
tables. Cell coordinates are limited to BIFF8's 65,536 rows and 256 columns.
The reader caps the workbook at 4,096 sheets, 100,000 cells, 50,000 cells per
sheet, and 50,000 merge anchors across the workbook; exceeding those internal
caps raises `LimitExceededError`. Cell text and optional formula text are
preflighted before retention, formula text is charged once, and emitted cell
counts are charged once through the shared budget. When a caller-configured
limit truncates the workbook, a `TRUNCATED` warning reports omitted cell and
row counts.

Malformed records produce a content-free `UNREADABLE_PART` warning when a
valid sheet prefix can still be returned. A malformed Workbook globals stream
or a workbook without a valid worksheet fails with `CorruptFileError`. The
reader does not claim support for every BIFF8 record or formula token.

The implementation is based on Microsoft's public [MS-XLS record
specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/170e90ce-87d7-4758-9331-dcf14cd72388),
including [BoundSheet8](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/b9ec509a-235d-424e-871d-f8e721106501),
[FormulaValue](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/39a0757a-c7bb-4e85-b144-3e7837b059d7),
and [STRING](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/504b6cfc-d57b-4296-92f4-ceefc0a2ca9b).

`corpus/xls/biff8-source.xls` is a CC0 LibreOffice export of a self-authored
fixture; its `.license` sidecar records the source and conversion details.
It exercises sheet ordering and state, Unicode/SST continuation, cached values,
dates, errors, merges, and prototype-looking names. It is currently checked by
a direct-reader integration test; a public extraction golden requires the
lead-owned reader registration and golden-pipeline integration.

# XLSB records and reader subset

The XLSB reader resolves the workbook part through package relationships,
follows workbook sheet relationships in workbook order, and parses a bounded
subset of binary parts. It reads workbook date-system flags, sheet visibility,
shared rich-string text, custom and built-in number formats, cached scalar cell
values, hidden rows and columns, and merge anchors. Sparse cell coordinates are
grouped into contiguous horizontal runs and adjacent runs with matching column
bounds are coalesced into table ranges. The adapter retains sheet visibility
internally and emits it through the shared document section metadata.
The reader descriptor advertises the IANA whole-workbook type
[`application/vnd.ms-excel.sheet.binary.macroEnabled.12`](https://www.iana.org/assignments/media-types/application/vnd.ms-excel.sheet.binary.macroEnabled.12);
the `.main` content type remains the internal workbook-part type in the
synthetic package's `[Content_Types].xml`, with an explicit override for
`/xl/workbook.bin` (the generic `.bin` default does not replace that part type).

Supported worksheet scalar values include blank, RK, error, Boolean, real,
inline string, shared string, and cached formula string/number/Boolean/error
records. Explicit `BrtCellBlank` records are retained as addressed empty cells,
so blank cells preserve positions between values and can form blank-only table
ranges. Formula results are read from their cached values; formula token
rendering is not implemented. If callers request formula text, the reader
emits a generic `UNREADABLE_PART` warning. Shared-string rich text is reduced
to its text; run formatting and phonetic annotations are not retained. Invalid
shared-string indexes and malformed optional styles are skipped with static,
content-free warnings. The implementation does not parse drawings, tables,
filters, hyperlinks, comments, external links, macros, or other workbook
features beyond feature scanning. The descriptor is not registered in the
top-level reader registry yet.

`iterXlsbRecords(bytes, budget)` walks a binary part without interpreting its
record-specific payloads. Each yielded record has a type id, source byte
offset, and a `Uint8Array` payload view into the original input. Unknown type
ids are preserved for the caller to skip or interpret. The iterator stops
after 1,000,000 records; that defensive parser cap is independent of the
configured spreadsheet output-cell limit.

MS-XLSB encodes a record type in one byte unless the low byte's high bit is
set; then a second byte carries its next seven bits. Record data length uses
one to four continuation-coded bytes, with seven value bits per byte and
low-order bits first. A fourth size byte ends the field even when its high bit
is set; the spec says to ignore that bit. The parser rejects a truncated
header, a set continuation bit in the second type byte, a non-canonical
two-byte type below 128, or a declared payload size larger than the remaining
part. These failures throw a generic `CorruptFileError` without including
input bytes or content. It does not copy or retain payload bytes beyond each
yielded view.

`XlsbCursor` reads little-endian unsigned 8-, 16-, and 32-bit values and
64-bit `Xnum` floating-point values. `readF64()` rejects infinities, NaN,
denormalized values, and negative zero, which MS-XLSB disallows for `Xnum`.
Floating-point `RkNumber` values use the same validity checks after
reconstruction; signed-integer RK encodings remain signed integers and are not
subject to floating-point checks.
`readWideString()` and `readNullableWideString()` read four-byte character
counts followed by UTF-16LE code units. The nullable form maps `0xFFFFFFFF`
to `null`; the non-nullable form rejects that count. Both verify the count,
configured helper cap, and available byte length before decoding or allocating
a string. Strings are capped at 1,000,000 code units, and malformed UTF-16
(including unpaired surrogates) throws generic `CorruptFileError`. Exceeding
the record or string cap throws `LimitExceededError` with the static limit
names `xlsbRecordCount` or `xlsbStringCodeUnits`; no file-provided text enters
the error. A BOM is preserved as content.

Every record/header byte and every field byte scanned ticks the shared
`Budget`; cancellation and timeout errors propagate. Additional reader caps
bound sheet, cell, shared-string, style, text, and merge retention. The reader
uses `LimitExceededError` for hard defensive counts and shared budget
truncation for configured output limits.

The shared-string part caps each decoded `XLWideString` at 1,000,000 code
units before allocating it. Its 20,000,000-character cumulative retention cap
is checked after each bounded string has been decoded, so at most one such
string is temporarily decoded before the aggregate cap is applied; the
implementation does not claim an aggregate pre-decode guard.

The binary fixtures under
[`packages/docsluice/test/readers/xlsb/fixtures`](../../packages/docsluice/test/readers/xlsb/fixtures)
are self-authored synthetic packages, generated by
`generate-reader-fixtures.mjs`; adjacent `.license` files mark each package
CC0-1.0. Regenerate them from the repository root with:

```sh
node packages/docsluice/test/readers/xlsb/fixtures/generate-reader-fixtures.mjs
```

Fixtures test relationship-resolved workbook order (including deliberately
non-sorted part names), hidden states, values and cached formulas, custom
formats, merge anchors, sparse coordinates, retained blank cells, invalid
shared-string indexes and style records, malformed and duplicate worksheet
records, unresolved and non-worksheet links, the 1904 date system, quota
truncate/throw behavior, strict warnings, cancellation, and malformed package
data. Expected
outputs in unit tests are authored behavioral assertions, not Excel or
LibreOffice golden files.
The `fixtures/corpus/edgecases.xlsb` copy and `edgecases.expected.json` provide
a small CC0 seed and reviewed ranges/addresses for reproducible corpus checks;
their expected JSON describes authored package behavior, not application
compatibility.

The whole-reader fuzz entry point is `packages/docsluice/fuzz/xlsb.fuzz.ts`;
its smoke test sends malformed byte samples and an authored package through
the same registered reader descriptor.

LibreOfficeDev `26.8.0.0.alpha0` (`2c87e51eeaa2b413ff4ae097b2705eea1995d8e5`)
was probed with `soffice --headless --convert-to xlsb`; the installed build
reported that no XLSB export filter was available. No LibreOffice-generated
XLSB golden or compatibility claim is made.

The wire rules follow Microsoft's primary
[MS-XLSB Record specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/7bf1de78-9cda-4002-8411-086f79cd4b60),
[record ids by number](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/30e2eaae-0b1e-4e8e-a465-e1ce5575868d),
[Cell Table](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/33035e84-cb66-4323-a8bc-d45e287bd7ec),
[BrtCellBlank](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/464efd74-dfeb-40b0-b0e5-9074329fab2f),
[RkNumber](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/a2b3ffec-dded-447b-b700-71b60e3c84da),
[BrtBundleSh](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/1edadf56-b5cd-4109-abe7-76651bbe2722),
[BrtWbProp](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/4d7ffab6-6ba7-4825-94f8-a5eb3fedbd22),
[BrtColInfo](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/691c6d4e-74c0-4e82-8841-d36e28e4772d),
[Cell XFs](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/3caef755-4524-4031-8cda-18b9fd8c5abc),
[XLWideString](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/5253755b-33cb-4796-835d-caf07bf70ad4),
[XLNullableWideString](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/4423e5dc-fcea-4b66-8230-ea80cab5a2d1),
and [Xnum](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/d3e174ba-0eab-452a-970f-57267270dd9e).
The synthetic `record-comment-text-example.bin` unit fixture uses the record
header bytes from the specification's example and a zero-filled payload; its
CC0 sidecar records that it is not an Excel-generated record.

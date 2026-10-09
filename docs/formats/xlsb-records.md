# XLSB binary record primitives

`iterXlsbRecords(bytes, budget)` walks a binary part without interpreting the
record-specific payloads. Each yielded record has a type id, source byte offset,
and a `Uint8Array` payload view into the original input. Unknown type ids are
preserved for the caller to skip or interpret. The iterator stops after
1,000,000 records; that defensive parser cap is independent of the configured
spreadsheet output-cell limit.

MS-XLSB encodes a record type in one byte unless the low byte's high bit is set;
then a second byte carries its next seven bits. Record data length uses one to
four continuation-coded bytes, with seven value bits per byte and low-order
bits first. A fourth size byte ends the field even when its high bit is set; the
spec says to ignore that bit. The parser rejects a truncated header, a set
continuation bit in the second type byte, or a declared payload size larger than
the remaining part. These failures throw a generic `CorruptFileError` without
including input bytes or content. It does not copy or retain payload bytes
beyond each yielded view. Two-byte type encodings must decode to at least 128,
as required by the format's one-byte/two-byte distinction.

`XlsbCursor` reads little-endian unsigned 8-, 16-, and 32-bit values and 64-bit
`Xnum` floating-point values. `readF64()` rejects infinities, NaN, denormalized
values, and negative zero, which MS-XLSB disallows for `Xnum`. `readWideString()`
and `readNullableWideString()` read four-byte character counts followed by
UTF-16LE code units. The nullable form maps `0xFFFFFFFF` to `null`; the
non-nullable form rejects that count. Both verify the count, configured helper
cap, and available byte length before decoding or allocating a string. Strings
are capped at 1,000,000 code units, and malformed UTF-16 (including unpaired
surrogates) throws generic `CorruptFileError`. Exceeding the record or string
cap throws `LimitExceededError` with the static limit names `xlsbRecordCount`
or `xlsbStringCodeUnits`; no file-provided text enters the error. A BOM is
preserved as content.

Every record/header byte and every field byte scanned ticks the shared
`Budget`; cancellation and timeout errors propagate. These helpers do not open
ZIP packages, resolve parts, validate the record enumeration, parse workbook
relationships, or provide XLSB reader acceptance. LibreOffice XLSB export
support remains unverified, so no generated XLSB golden file is claimed.

The wire rules follow Microsoft's primary
[MS-XLSB Record specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/7bf1de78-9cda-4002-8411-086f79cd4b60),
[XLWideString](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/5253755b-33cb-4796-835d-caf07bf70ad4),
[XLNullableWideString](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/4423e5dc-fcea-4b66-8230-ea80cab5a2d1),
and [Xnum](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xlsb/d3e174ba-0eab-452a-970f-57267270dd9e).
The synthetic `record-comment-text-example.bin` unit fixture uses the record
header bytes from the specification's example and a zero-filled payload; its
CC0 sidecar records that it is not an Excel-generated record.

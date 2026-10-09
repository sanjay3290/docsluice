# BIFF8 record and shared-string helpers

`iterateBiffRecords(bytes, budget)` walks a Workbook stream as BIFF records. It
reads the two-byte record id and two-byte payload length in little-endian order,
returns payload views into the input, and rejects incomplete headers, payloads
that exceed the remaining stream, record data longer than 8,224 bytes, and
streams exceeding 1,000,000 records. The record cap is checked before the next
record is yielded, so consumers cannot retain an unbounded array of empty
records under the default byte limits. It
requires a BIFF8 BOF record (`vers = 0x0600`) at the start and validates later
BOF records as well. A FILEPASS record raises `EncryptedError`; encrypted XLS
workbooks are not decrypted. BIFF5 and older BOF versions are unsupported: the
helper adds one content-free `UNREADABLE_PART` warning and throws
`UnsupportedFormatError`.

`readBiff8Sst(sstData, continueBodies, budget)` reads the SST counts and its
unique `XLUnicodeRichExtendedString` entries from the SST body plus the ordered
payload bodies of the immediately following CONTINUE records. It validates the
advertised counts, but does not preallocate from them. The hard limits are
100,000 strings and 20,000,000 UTF-16 code units; exceeding either raises
`LimitExceededError` before allocating beyond the cap. Variable record text is
decoded as one-byte Unicode code points when `fHighByte` is clear, and as
UTF-16LE code units when it is set. Rich-format runs and ExtRst payloads are
length-checked and skipped; this helper returns plain string values only.

When character bytes continue into another record, the first byte of that
CONTINUE payload supplies the new `fHighByte` setting. Boundaries in string
headers, rich-format runs, and ExtRst data do not consume an option byte. A
truncated stream, invalid header, missing continuation option, partial wide
character, reserved flag bit, or inconsistent count raises a generic
`CorruptFileError` without including workbook content. The loops are iterative
and tick the caller's shared `Budget`; neither helper uses Node APIs or recurses
over file data.

The `cch` field is an unsigned 16-bit count, so this format-level helper permits
up to 65,535 UTF-16 code units per string, subject to the 20,000,000-code-unit
table cap. Excel's user-facing cell-content limit is 32,767 characters; this
helper does not enforce that worksheet/application constraint while decoding
the SST structure. Reserved bits in the string flags and character-continuation
option byte are rejected.

This module handles record framing and shared strings only. It does not parse
worksheets, cells, formulas, number formats, names, or workbook metadata. It is
not XLS reader acceptance or a golden extraction test.

The implementation follows Microsoft's public [MS-XLS Record](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/170e90ce-87d7-4758-9331-dcf14cd72388),
[BOF](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/4d6a3d1e-d7c5-405f-bbae-d01e9cb79366),
[FilePass](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/cf9ae8d5-4e8c-40a2-95f1-3b31f16b5529),
[SST](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/b6231b92-d32e-4626-badd-c3310a672bab),
[Continue](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/999fae21-d3d9-42e8-8290-639782460c67), and
[XLUnicodeRichExtendedString](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/173d9f51-e5d3-43da-8de2-be7f22e119b9)
sections. The unsigned `cch` field is defined by the [XLUnicodeRichExtendedString structure](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/173d9f51-e5d3-43da-8de2-be7f22e119b9); Excel's 32,767-character cell limit is listed in its [specifications and limits](https://support.microsoft.com/en-us/excel/excel-specifications-and-limits).

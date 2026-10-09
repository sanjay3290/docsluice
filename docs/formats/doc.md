# Legacy Word documents (.doc)

Legacy Word documents are OLE compound files. The reader selects the `0Table` or
`1Table` stream from the FIB, follows the CLX piece table in CP order, decodes
compressed Windows-1252 and UTF-16 pieces, and stages paragraphs and table rows
from paragraph and cell marks. It resolves built-in Heading 1–9 style IDs from
PAPX/FKP records and emits heading blocks. It displays field results and skips
field instructions. Files marked encrypted or obfuscated in the FIB fail with
`ENCRYPTED`; docsluice does not attempt password recovery or decryption.

The parser recognizes plain paragraphs, built-in heading styles and table cells.
It does not yet resolve custom style outline levels from STSH data; those
paragraphs remain paragraphs. Headers, footers, footnotes and endnotes are not
emitted yet; they use separate CP ranges and PLC structures that still need
reader support.
List numbering, tracked changes, comments, drawings, text boxes, hyperlinks and
revision display are also outside this parser profile. Malformed piece tables,
CP sequences and stream ranges fail as `CORRUPT_FILE` before staged blocks are
emitted.

The implementation follows Microsoft's public [MS-DOC specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/ccd7b486-7881-484c-a137-51170af7cc22),
including its [text retrieval algorithm](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/01d5d8c4-cf9c-4ef9-80fd-439e763cfe01),
[FIB table-stream flag](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/26fb6c06-4e5c-4778-ab4e-edbf26a545bb),
[paragraph boundaries and PAPX formatting](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/30461a5b-e3ad-44cd-a3fe-038f86639b13),
and [compressed-character mapping](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/aa2e55a2-f4f2-4795-bab5-6d9d7a0ed249).

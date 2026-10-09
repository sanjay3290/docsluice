# CSV and TSV

CSV and TSV are decoded using the shared text encoding detector and emitted as one table block. CSV chooses comma, semicolon, tab or pipe by the most consistent nonzero delimiter count among the first 50 physical lines outside quoted fields. TSV always uses tab. Quoted fields support delimiters, doubled quotes and line breaks; a leading BOM is skipped. Empty physical lines are ignored, while ragged rows are padded to the widest retained row. Cells use spreadsheet addresses from `A1` through `XFD` and padding counts toward the shared `cells` budget. `headerRows` remains `0` until header detection is specified.

Malformed quoting produces `UNREADABLE_PART` without including file content in the warning. An input, cell or output limit produces a `TRUNCATED` warning and a partial table. The reader caps parsing at the configured cell and output allowances; it does not allocate rows or columns from a file-declared dimension.

Delimiter sniffing is limited to an 8 KiB prefix. The byte-array reader decodes in 64 KiB chunks and stops decoding when a cell or output limit is reached. The incremental tokenizer preserves CRLF, doubled quotes and split UTF-8 code points.

The isolated `readDelimitedStream()` helper produces table blocks in batches of at most 1,000 rows and awaits its flush callback after at most 8 KiB of decoded input. Ragged rows are padded to each batch's width; separate batches can therefore have different widths. Its input `chunks()` must yield the complete stream including the sniffing `prefix`. The helper is not connected to the public reader API yet: core `extractStream` and `onBlock` support (#64) and confirmation of the prefix/chunk contract are pending.

Run the opt-in 1 GiB helper benchmark with `DOCSLUICE_SLOW=1 npx vitest run packages/docsluice/test/readers/csv/csv-stream.slow.test.ts`.

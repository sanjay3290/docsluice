# CSV and TSV

CSV and TSV are decoded using the shared text encoding detector and emitted as one table block. CSV chooses comma, semicolon, tab or pipe by the most consistent nonzero delimiter count among the first 50 physical lines outside quoted fields. TSV always uses tab. Quoted fields support delimiters, doubled quotes and line breaks; a leading BOM is skipped. Empty physical lines are ignored, while ragged rows are padded to the widest retained row. Cells use spreadsheet addresses from `A1` through `XFD` and padding counts toward the shared `cells` budget. `headerRows` remains `0` until header detection is specified.

Malformed quoting produces `UNREADABLE_PART` without including file content in the warning. An input, cell or output limit produces a `TRUNCATED` warning and a partial table. The reader caps parsing at the configured cell and output allowances; it does not allocate rows or columns from a file-declared dimension.

Delimiter sniffing is limited to an 8 KiB prefix. The reader then decodes the supplied byte array in 64 KiB chunks and stops decoding when a cell or output limit is reached. The incremental tokenizer preserves CRLF, doubled quotes and split UTF-8 code points. Core `extractStream` support and bounded-memory streaming through `extractStream` are pending the core `onBlock`/stream API (#64); the current reader still receives a complete byte array.

`extract()` loads this reader lazily for `csv` and `tsv` input. It is also available as the `docsluice/csv` (`csvReader`, `tsvReader`) and `docsluice/tsv` (`tsvReader`) subpaths.

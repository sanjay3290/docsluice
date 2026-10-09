# Legacy Word (`.doc`)

Legacy Word files are the only format with a registered extractor in this foundation. The reader extracts plain paragraphs, built-in Heading 1–9 styles, and table cells. It resolves compressed Windows-1252 and UTF-16 text pieces and uses paragraph formatting for built-in heading styles.

Encrypted or obfuscated files fail with `ENCRYPTED`; passwords are not supported for this format. Custom-style outline levels, headers and footers, notes, comments, images, hyperlinks, list numbering, tracked changes, text boxes, and embedded documents are not yet emitted. Malformed piece tables and out-of-range stream references fail as `CORRUPT_FILE`.

See the generated [API reference](/api/index.html).

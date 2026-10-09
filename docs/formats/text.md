# Detection and text formats

`detect(input, options?)` normalizes supported byte inputs under the input-byte limit and returns only `{ format, mimeType, confidence, encoding? }`. Blob and stream inputs are fully normalized to bytes before resolution; format probes then inspect bounded prefixes, ZIP/CFB structural indexes and small ZIP markers. Detection does not parse document content or expose its internal warnings. When `strict` selects `FORMAT_MISMATCH` or `ENCODING_GUESSED`, detection throws the usual `StrictModeError`.

The detector trusts a forced `format` option without sniffing. Otherwise, binary signatures win over filename and MIME hints. ZIPs are indexed once and their bounded package markers are inspected; OLE files are indexed once and classified from root stream names. Text detection uses an 8 KiB sample plus at most three bytes of UTF-8 boundary lookahead. Filename and MIME hints can choose between tied plain-text/Markdown or CSV/TSV candidates, but cannot override a structural match such as JSON or an image signature. A detected format that conflicts with a recognized hint, including an unknown binary sample with a specific hint, adds an internal `FORMAT_MISMATCH` warning containing format names only.

The text detector classifies content from at most the first 8 KiB. It recognizes JSON, XML, HTML, CSV, TSV, Markdown and plain text. CSV/TSV detection checks delimiter counts across non-empty rows while respecting quoted fields, including quoted newlines. Text it cannot confidently place in a structured format is treated as plain text.

Encoding detection checks UTF-8, UTF-8/UTF-16 byte-order marks, UTF-16 NUL-byte patterns, then Windows-1252 when a byte sample is not valid UTF-8. A Windows-1252 fallback carries the `ENCODING_GUESSED` warning. UTF-32 BOMs are reported as unsupported. A high share of control bytes marks the input as binary.

PNG and ZIP signatures are treated as binary even when their samples contain many printable bytes. The detector does not parse the document. HTML charset declarations, detailed CSV dialects, and formats beyond the list above are outside this detection step.

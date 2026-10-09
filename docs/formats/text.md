# Text formats

The detector classifies content from at most the first 8 KiB. It recognizes JSON, XML, HTML, CSV, TSV, Markdown and plain text. CSV/TSV detection checks delimiter counts across non-empty rows while respecting quoted fields, including quoted newlines. Text it cannot confidently place in a structured format is treated as plain text.

Encoding detection checks UTF-8, UTF-8/UTF-16 byte-order marks, UTF-16 NUL-byte patterns, then Windows-1252 when a byte sample is not valid UTF-8. A Windows-1252 fallback carries the `ENCODING_GUESSED` warning. UTF-32 BOMs are reported as unsupported. A high share of control bytes marks the input as binary.

PNG and ZIP signatures are treated as binary even when their samples contain many printable bytes. The detector does not parse the document. HTML charset declarations, detailed CSV dialects, and formats beyond the list above are outside this detection step.

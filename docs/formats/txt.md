# Plain text (TXT)

The TXT reader detects UTF-8, UTF-16LE/BE and Windows-1252 using the shared bounded encoding detector, reports the chosen encoding, and emits one paragraph for each non-empty group of lines. Blank lines separate paragraphs; LF and CRLF inside a paragraph become LF. Whitespace-only lines are separators.

Text is scanned with budget ticks, and output is capped by `outputChars`. If a paragraph crosses the remaining output allowance, the reader emits the fitting prefix, records `TRUNCATED`, and stops. Encoding fallback warnings contain no source text.

The reader preserves ordinary text rather than interpreting markup. It does not infer titles, authors or other metadata.

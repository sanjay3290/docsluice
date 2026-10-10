# Plain text (TXT)

The TXT reader detects UTF-8, UTF-16LE/BE and Windows-1252 using the shared bounded encoding detector, reports the chosen encoding, and emits one paragraph for each non-empty group of lines. Blank lines separate paragraphs; LF and CRLF inside a paragraph become LF. Whitespace-only lines are separators.

Text is scanned with budget ticks, and output is capped by `outputChars`. If a paragraph crosses the remaining output allowance, the reader emits the fitting prefix, records `TRUNCATED`, and stops. Encoding fallback warnings contain no source text.

The reader preserves ordinary text rather than interpreting markup. It does not infer titles, authors or other metadata.

`extract()` loads this reader lazily for `txt` input. It is also available as the `docsluice/txt` subpath (`txtReader`).

## Source code

A file whose name has a source-code extension (`.py`, `.js`, `.ts`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.cs`, `.rb`, `.php`, `.sh`, `.sql`, `.toml`, `.ini` and others; see `CODE_LANGUAGES` in `src/detect/mime.ts`) is read as text and becomes one `code` block with its `language` (`python`, `javascript`, …), limited by `outputChars`. A source file whose comments look like Markdown headings (`# …`) stays text. The format stays `txt`: source code has no format id of its own.

# DOCX support

The DOCX reader extracts Word paragraphs in document order, including paragraphs inside tables, content controls, and text boxes. Built-in heading styles (`Heading 1` through `Heading 6`, plus `Title`), localized heading names, and custom styles with inherited outline levels become heading blocks. A paragraph's own `w:outlineLvl` overrides its style: levels 0–5 are headings 1–6, and any other level (9 is body text) is a paragraph. Hyperlinks retain their relationship target; bookmark links retain visible text. Set `runs: true` to retain bold, italic, and hyperlink details in paragraph runs.

The body is read from the `word/document.xml` part with the shared SAX XML scanner. Markup compatibility `AlternateContent` emits one branch: a supported `Choice` or its `Fallback`. Textbox paragraphs appear at their anchor position; surrounding anchor text is kept in ordered paragraph segments. Field instruction text is never returned. Lists, table block construction, images, revisions, notes, and other ancillary parts are handled by separate reader work.

XML depth and staged output are governed by the shared `Budget`. A caller's abort signal, strict warning policy, output-character limit, and XML depth limit therefore apply while scanning the DOCX body.

`extract()` loads this reader lazily for `docx` input. It is also available as the `docsluice/docx` subpath (`docxReader`). Package parts, relationships, document properties and feature flags (macros, external links, embedded files) come from the shared OOXML helpers (see [ooxml.md](ooxml.md)).

Performance (PERF-1): a 5.5 MB DOCX with about 40,000 paragraphs extracts in 0.75–0.94 s on a development machine. #182 tracks more headroom.

Hostile samples in `hostile/docx/`: 10,000 nested content controls (stopped by the XML depth budget with `TRUNCATED`), a 40 MB `document.xml` in a small archive (`LIMIT_EXCEEDED` from the compression-ratio check), and prototype-named style ids (inert).

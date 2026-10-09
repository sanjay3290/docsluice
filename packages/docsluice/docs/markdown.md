# Markdown renderer

`toMarkdown(document, options)` returns deterministic GitHub-flavoured Markdown. It is exported from the package entry point with the `MarkdownOptions` type. Source text is escaped where it could create Markdown structure or raw HTML. Link targets accept `http:`, `https:`, `mailto:`, `tel:`, and relative references; unsafe targets are written as visible text.

Headings, paragraphs (including formatted runs), nested lists, tables, fenced code, image references, notes, headers, footers, and page/slide/sheet/part sections are supported. Notes render as blockquotes labeled with their role. Headers and footers are omitted by default. Section markers default to headings (`## Page 3`, `## Slide 2: Title`, `## Sheet: Revenue`); callers can select safe HTML comments or omit markers.

Tables flatten merged cells by default, keeping merged text only in the top-left cell and using `<br>` for line breaks. With `tables: 'html'`, tables that contain merged or multiline cells use an escaped HTML table with `rowspan` and `colspan`; simple tables remain GFM pipe tables. The defaults cap tables at 200 source rows and 50 source columns. A final omission line reports any omitted rows and columns. ADR 0007 records the merged-cell decision.

Each render uses the default internal processing budget (`blockDepth: 64`, `cells: 2,000,000`, `outputChars: 20,000,000`, and `timeMs: 60,000`) and throws the corresponding limit error rather than returning a partial Markdown string. These are renderer internals and do not add extraction options.

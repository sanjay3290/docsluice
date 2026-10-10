# DOCX support

The DOCX reader extracts Word paragraphs in document order, including paragraphs inside tables, content controls, and text boxes. Built-in heading styles (`Heading 1` through `Heading 6`, plus `Title`), localized heading names, and custom styles with inherited outline levels become heading blocks. A paragraph's own `w:outlineLvl` overrides its style: levels 0–5 are headings 1–6, and any other level (9 is body text) is a paragraph. Hyperlinks retain their relationship target; bookmark links retain visible text. Set `runs: true` to retain bold, italic, and hyperlink details in paragraph runs.

The body is read from the `word/document.xml` part with the shared SAX XML scanner. Markup compatibility `AlternateContent` emits one branch: a supported `Choice` or its `Fallback`. Textbox paragraphs appear at their anchor position; surrounding anchor text is kept in ordered paragraph segments. Field instruction text is never returned.

XML depth and staged output are governed by the shared `Budget`. A caller's abort signal, strict warning policy, output-character limit, and XML depth limit therefore apply while scanning the DOCX body.

`extract()` loads this reader lazily for `docx` input. It is also available as the `docsluice/docx` subpath (`docxReader`). Package parts, relationships, document properties and feature flags (macros, external links, embedded files) come from the shared OOXML helpers (see [ooxml.md](ooxml.md)).

Performance (PERF-1): a 5.5 MB DOCX with about 40,000 paragraphs extracts in 0.75–0.94 s on a development machine. #182 tracks more headroom.

Hostile samples in `hostile/docx/`: 10,000 nested content controls (stopped by the XML depth budget with `TRUNCATED`), a 40 MB `document.xml` in a small archive (`LIMIT_EXCEEDED` from the compression-ratio check), prototype-named style ids (inert), and images with prototype-named alt text, nonsense extents and relationship ids plus nested revisions (inert, `HIDDEN_CONTENT`).

## Lists (DOC-3)

Numbered and bulleted paragraphs become `list` blocks. Numbering comes from `word/numbering.xml`: `w:abstractNum` levels (`w:numFmt`, `w:lvlText`, `w:start`, `w:lvlRestart`) and `w:num` instances with `w:lvlOverride` (`w:startOverride` or a replacement `w:lvl`). A paragraph's `w:numPr` wins over numbering inherited from its style through `basedOn`, and `numId` 0 removes inherited numbering.

- Each item's `marker` is the text a person sees. `%1` … `%9` in `w:lvlText` compose parent counters (`1.1.1.`). Formats: `decimal`, `decimalZero`, `lowerLetter`/`upperLetter` (`a` … `z`, `aa`, `bb`, … as Word does), `lowerRoman`/`upperRoman`, `ordinal` (English), `bullet`, `none`; anything else is decimal. Symbol-font bullets in the private-use area become `•` (common Wingdings glyphs map to `▪`, `➢`, `✓`, `❖`, `◦`).
- Consecutive list paragraphs form one block; any other paragraph ends it, and a new level-0 `numId` starts a new block. Counters continue per `numId` across blocks, as Word does. A deeper level restarts when a higher level is used, unless `w:lvlRestart` says otherwise.
- An item's parent is the nearest earlier item at a lower level. Nesting deeper than `blockDepth` is flattened by the builder with one `DEPTH_LIMIT`.
- A numbered heading stays a heading (its counter still advances). Empty numbered paragraphs produce no item.
- `ordered` is false only for bullet lists. The Markdown renderer writes CommonMark numbers for ordered lists; `toText` and JSON keep the stored markers.
- Level text longer than 255 characters is cut, so a hostile `w:lvlText` cannot inflate every marker.

## Tables (DOC-4)

Each `w:tbl` becomes a `table` block at its place in the document. A cell's paragraphs become the cell text, one line each.

- Rows follow the output model's grid: `rows[r][c]` is grid column `c`. A `w:gridSpan` cell gets `colSpan` and is followed by empty placeholder cells. A `w:vMerge` restart cell gets `rowSpan`, counting the continuation cells below it in the same grid column, and the continuations become empty placeholders. Spans wider than 64 columns are clamped (Word allows 63), so a tiny file cannot expand into millions of cells. Every cell, placeholders included, counts toward `cells`; the table stops at the limit with `TRUNCATED`.
- `headerRows` is the number of leading rows marked `w:tblHeader`.
- A nested table stays text-only inside its parent cell (tabs between cells, line breaks between rows), and is also emitted as its own `table` block right after the parent, in document order. Its own nested tables follow it.
- Tables nested deeper than `blockDepth` are flattened: their text joins the deepest kept cell, with one `DEPTH_LIMIT`. Very deep nesting then reaches the XML depth budget, which truncates the scan.
- A table ends an open list block.

## Headers, footers, notes and comments (DOC-5)

- Headers and footers are read from the parts that section properties reference (`w:headerReference`, `w:footerReference`) and become `header`/`footer` blocks: every distinct header text before the body and every distinct footer text after it, in reference order. Identical texts (for example a first-page and a default header with the same words) appear once. Their `loc.path` is the part (`word/header1.xml`).
- Footnotes, endnotes and comments become `note` blocks with `role` `footnote`, `endnote` or `comment`. Each note is emitted once, right after the block that references it: the paragraph holding the `w:footnoteReference`/`w:endnoteReference`, or the paragraph where a comment's range starts (`w:commentRangeStart`, or `w:commentReference` when there is no range). A comment range that starts between paragraphs attaches to the next one. Notes referenced inside a list item or table cell follow that list or table. Separator footnotes and endnotes (`w:type` `separator`, `continuationSeparator`, `continuationNotice`) are skipped.
- A comment's `author` is `w:author`, or `w:initials` when there is no author. Authors are personal data: `metadata: false` removes them.
- Note text keeps paragraphs as lines; `mc:Fallback` copies are skipped. Note, header and footer ids are kept in `Map`s, never as object keys.

## Tracked changes (DOC-6)

The `revisions` option picks what tracked changes produce. The default, `accept`, shows the document as if every change were accepted.

- `accept`: inserted text (`w:ins`, `w:moveTo`) stays, deleted text (`w:del`, `w:moveFrom`, `w:delText`) is dropped.
- `reject`: deleted text comes back and inserted text is dropped.
- `show`: both are kept and marked inline, `[+inserted+]` and `[-deleted-]`. Empty revisions produce no markers.
- A deleted paragraph mark (`w:del` under the paragraph's `w:rPr`) joins the paragraph with the next one in `accept` mode; an inserted paragraph mark does the same in `reject` mode.
- When the document has tracked changes, one `HIDDEN_CONTENT` warning says that some text is not in the output (in every mode: `show` still hides formatting changes).
- Images inside a hidden revision are dropped with it.

## Images (DOC-8)

Each picture becomes an `image` block at its place in the document, after the paragraph (or the list or table) that holds it.

- DrawingML pictures (`wp:inline`, `wp:anchor`): `alt` is `wp:docPr` `descr`, else its `title`; `width` and `height` come from `wp:extent`, converted from EMU to pixels at 96 dpi. Legacy VML pictures (`v:shape` with `v:imagedata`): `alt` is the shape's `alt`, else `o:title`; the size comes from its `style` (`pt`, `in`, `cm`, `mm`, `px`).
- An embedded picture (`r:embed`, `r:id`) gets `mimeType` from `[Content_Types].xml` and `ref` naming a listed child (`children`) at the image part's path. Bytes are included only with `childBytes: true`. `children: 'skip'` leaves out `ref` and the child list.
- A linked picture (`r:link` to an external target) has no `ref`; docsluice never fetches it.
- Values that cannot be parsed are left out; the block stays.

## Macro-enabled files

`.docm (and .dotm templates)` files are detected by their macro-enabled main content type and reported with their own format id (`docm`), and are read by this reader with the same blocks as the plain version. A VBA project part (`vbaProject.bin`) sets `features.hasMacros` and adds one `MACROS_PRESENT` warning. Macros are never parsed, extracted or run (SEC-11). `corpus/docx/headings-outline-macros.docm` is made by `scripts/corpus/make-macro-enabled.mjs`.

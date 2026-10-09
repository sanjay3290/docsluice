# PDF text layout helper preparation

This directory contains private pure helpers for laying out a supplied PDF text
layer. It is preparation for PDF-2, not a registered reader, parser adapter, or
end-to-end accuracy claim. The helper consumes synthetic or adapter-provided
text items; it does not read PDF operators, page outlines, or files.

`TextItem.transform` follows the PDF.js-style six-number matrix
`[a, b, c, d, e, f]` in PDF user space: `(e, f)` is the text origin, `(a, b)`
describes its inline direction, and `(c, d)` its vertical direction. `width`,
`height`, and `fontSize` are in page user units. For a page whose nonempty items
share one orthogonal quarter-turn text frame, the helper analyzes geometry in
that canonical frame, then remaps each line box to the page's clockwise
0/90/180/270 display coordinates. Rotated page dimensions are swapped for 90
and 270 degrees. Coordinates are rounded to 0.001 user units before sorting;
source index and original input index break ties. Each line retains its source
indices in reading order, while `sourceIndex` is the lowest contributing source
index. Caller inputs are not mutated. Invalid or absurd geometry and an
unsupported runtime rotation are ignored.

The bounded heuristic sorts items by baseline, groups nearby baselines (a
0.65-em tolerance), then separates very distant same-baseline runs. Within each
line, a gap above 0.25 em inserts a space; RTL lines preserve increasing source
index order and never reverse the text content. Items with unsupported runtime
directions such as `ttb` are skipped and counted in `unsupportedDirectionItems`;
the PDF adapter must resolve or split vertical text before calling this helper,
or emit a static warning when that count is nonzero. Whitespace between line starts
can form up to three columns if each detected column has at least two lines.
Wide whitespace-only boxes (larger than the same line-separation threshold) are
ignored as separators so a PDF.js gutter item cannot bridge text in adjacent
columns. Column order follows the canonical text frame, and returned boxes stay
in display coordinates. If nonempty items mix orientations or use unsupported
non-quarter-turn transforms, the helper keeps each item separate in source-index
order rather than guessing shared baselines; this can preserve fragmented text.
Wide lines split reading zones, and lines in the bottom 10% are emitted after
main content as footnotes. Paragraphs use line spacing and indentation, with a
small increase in split sensitivity when a larger gap follows terminal
punctuation or a font-size change. A trailing hyphen is removed only when the
next line starts with a lowercase ASCII letter. Large-font paragraphs are
marked as heading candidates only when no outline is present.

Input text is checked against the shared `outputChars` budget before it is
retained or joined. When truncation is permitted, the helper keeps a safe text
prefix and the budget records its normal truncation warning; this helper does
not charge output characters, because the eventual document builder does that.

These are intentionally modest synthetic-layout heuristics. Complex multi-
column pages with overlapping boxes, marginalia, vertical writing, unusual
fonts, tables, and footnotes interleaved with body text can remain ambiguous.
Real-page order and heading accuracy still require the PDF text-item adapter
and hand-reviewed corpus pages; no accuracy percentage is claimed here.

Tests use hand-authored items with the real shared `Budget`, including cases
copied from a local PDF.js 5.6.205 extraction snapshot for two/three-column
gutter whitespace and a rotated page, plus synthetic title and bottom-footnote
placement, spacing, superscript-sized items, dehyphenation, RTL source order,
rotation, invalid geometry, aborts, and deterministic tie-breaking. This small
adapter-shaped sample does not establish corpus-level reading accuracy. The
helper performs sorting and sweep-style row grouping rather than comparing
every item pair.

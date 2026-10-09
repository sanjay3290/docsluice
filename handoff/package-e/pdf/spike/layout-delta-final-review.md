# Independent final review: package E #46 layout delta

Reviewed read-only at `docsluice-package-e-46` HEAD
`55a60269d5b4a5c0e53e3e96b6dcbbf72338c805`, against
`bd9ddf3afc3e28b693868b8f26f84bc75f3f5df0`. The change is confined to the
private layout helper, its unit tests, and PDF layout documentation. I found
no blocking correctness or security issue in the reviewed delta.

The new orientation scan rejects missing, oversized, blank, malformed, skewed,
or mutually inconsistent text frames. It checks only a fixed six-number
transform and caps inspected text length at `MAX_ITEM_TEXT`; budget ticks cover
the scan, geometry, sorting callbacks, and remapping. Invalid/mixed frames take
the source-order, one-item-per-line path, preserving text rather than merging
items against an unreliable baseline. Normalization still enforces finite
coordinates and existing extent/font/output limits. Unsupported directions
remain skipped and counted as before. The preexisting RTL content-stream test
continues to cover RTL concatenation; the new reading-order changes do not
reverse characters or introduce an RTL-only sort.

For uniform canonical orientations, the helper analyzes lines and paragraphs
in the orientation frame, maps every bounding-box corner back into display
coordinates, and rebuilds paragraph `lines` from the mapped line objects. This
keeps paragraph grouping invariant while preserving reference identity. The
new tests exercise raw-horizontal pages at 90/180/270 degrees, upright text
pre-rotated on a 90-degree page, upside-down content, mixed orientations, and
paragraph reference identity. The gutter fix discards a whitespace-only box
when it exceeds the established maximum line gap, so a column-wide separator
cannot glue adjacent columns together.

The real original ten-page synthetic phrase spot check is accurately scoped in
`layout-probe-comparison-after.json`: 8/10 pages match authored reading order,
all expected phrases appear on all ten, and the two table pages remain
column-wise although their authored reference is row-wise. This is not a word
accuracy score, corpus measure, all-pages success, or public-reader acceptance.
The follow-up note should retain those limits. This outstanding table-order
case is a known limitation, not a blocker for this private helper delta.

No source changes or additional tests were made during this review. The task
handoff reports full verification and focused coverage; this review relied on
the diff, existing tests, and recorded probe artifacts rather than rerunning
the suite.

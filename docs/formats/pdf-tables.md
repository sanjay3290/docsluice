# PDF table staging (PDF-8)

`src/readers/pdf/tables/` is a private heuristic stage. It accepts page dimensions,
already positioned `LayoutLine` objects, axis-aligned rule segments, and the
shared `Budget`. It does not parse PDF operators, read files, create `TableBlock`
objects, or change the public model. The PDF engine/operator adapter and the
reader-to-builder integration remain separate work.

The ruled path rounds coordinates to 0.001 page units, merges duplicate and
adjacent collinear segments, and looks for rectangular connected regions whose
cell edges are complete. It ignores diagonal rules and incomplete boundaries.
The unruled path groups positioned line items into baselines and looks for at
least three rows with the same two-or-more aligned cell starts. The current
`LayoutLine` contract provides one geometry per line, so unruled detection only
works when the adapter supplies separately positioned cell-level lines; it
cannot split a combined line string into word boxes.

Each candidate contains rows/cells, sorted unique source text-item indices,
rounded bounds, and a modest heuristic confidence (`0.72` for fully ruled,
`0.55` for aligned). Confidence is an internal candidate attribute; the public
model has no confidence field. The later caller should emit a table caption
containing the confidence and may emit a content-free low-confidence warning.
Threshold and warning policy belong to the reader integration. This module
never includes document text in warnings.

The stage uses fixed input/grid caps, stable sorting and rounding, a sweep over
the bounded coordinate grid, and `Budget.tick()` within work loops. It checks
the actual complete-cell count against the remaining `cells` allowance before
allocating the occupancy grid. If the plan exceeds that allowance, it calls
`budget.addCells(plannedCount)` to trigger the configured limit policy and
returns no plan (or propagates the configured exception). Successful staging
does **not** charge `cells` or `outputChars`: the eventual builder emission is
responsible for charging accepted cells and text. The stage calls
`checkOutputChars(stagedTextLength)` to check staged text without double
counting existing output. The reader must not call it with the budget's
`outputChars` value included.

The ruled analysis preflight counts all complete bordered cells before rejecting
components too small to form a table. This conservative work bound can therefore
trigger the cell limit for isolated 1×1 cells even when no table is returned.
The same four isolated cells stay uncharged and produce no table when they fit.

The ruled occupancy grid is capped at 65,536 possible cells. The unruled path
does not allocate a row-by-column matrix; each staged cell must correspond to
an input line, and the input is capped at 100,000 lines. Both paths still
preflight their derived table-cell count against the caller's remaining
`cells` allowance.

Tests use independent hand-authored synthetic cell facts: the ruled 2×2 case
and aligned 3×2 case recover all 10 expected populated cell texts in their
expected coordinates (10/10 exact on these two positive fixtures). Negative,
incomplete-grid, boundary-near, duplicate-rule, malformed-geometry, stable
ordering, input immutability, output/cell budget, and abort cases are also
covered. This is a synthetic test result, not a corpus or real-PDF accuracy
measurement. Real-PDF cell accuracy, source-operator mapping, confidence
calibration, and performance remain unmeasured pending the PDF engine and
layout/operator integration (#44–46, #27).

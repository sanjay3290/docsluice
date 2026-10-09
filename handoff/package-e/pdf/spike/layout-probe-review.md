> Baseline report for helper bd9ddf3. The later column/rotation delta is recorded in the addendum below and in the after-result files; baseline outputs are retained unchanged.

# Private #46 layout helper: real-engine input probe

This is a throwaway compatibility / accuracy spot check, not consumer-reader acceptance. The helper is imported from private #46 at `/workspace/docsluice-package-e-46/packages/docsluice/src/readers/pdf/layout/layout.ts`; no source changes were made. The prepared ten-page synthetic PDF has CC0 sidecar provenance and a manually authored independent source-facts reference. Fixture metadata explicitly labels it `ORIGINAL_SYNTHETIC_SOURCE_FACTS_ONLY` and `readerAcceptance: NOT_TESTED`.

## Input adapter and runtime results

`layout-probe.mts` extracts local PDF bytes with unpdf 1.7.0 / PDF.js 5.6.205, reads `page.getTextContent()`, and adapts raw string items using `str`, six-number `transform`, `width`, `height`, `dir`, and stable source index. Font size is derived as `Math.hypot(transform[0], transform[1])`. Page geometry comes from the page view and rotation from `page.rotate`. The source helper receives a real #46 `Budget` and `DEFAULT_LIMITS`. No expected output was fed into the adapter/helper.

The compiled probe ran on official Node v20.20.2, v22.23.3, and v24.19.0. Each emitted 10 pages / 45 layout lines and byte-for-byte identical `pages` JSON. The adapter's expected raw PDF.js fields and numeric transforms were present on this fixture across all three runtimes. This is evidence for this Node/PDF.js/version/fixture path only; it does not establish Bun, Deno, browsers, Workers, hostile-input, or full consumer behavior.

## Independent reference comparison

Compared each page's content-line order to the independent source-facts phrases, after excluding the known repeated header and footer. A page counts as matching only when every expected phrase occurs in reference order. Result: **7/10 pages fully ordered; 3/10 have order mismatches**. All expected phrase text was present. Mismatches:

- Page 2 (two columns): helper emits same-baseline text row-wise (`Left column first line Right column first line`, then second row); reference is column-wise. The expected “Right column first line” therefore occurs before “Left column second line”.
- Page 3 (three columns): helper emits row-wise across columns; source reference is column-wise. `Column B row one` and `Column C row one` occur before `Column A row two`.
- Page 8 (rotation 90): helper orders `Rotation content line` before `Rotated page source geometry`, opposite the manually authored reference.

Pages 1, 4–7, 9, and 10 preserve all reference phrases in order. Page 6 preserves the `Water`, superscript `2`, remainder sequence but merges it into one line. Page 7 keeps source line-end hyphenation (`Inter-` then `nationalization...`). Table pages preserve row/cell sequence, but this helper emits lines, not table cells; it does not prove table-parser accuracy. Header/footer text remains in helper output, also expected until the separate header/footer stage.

This small designed source fixture identifies concrete layout limits; it is not a corpus-level reading-order score or an end-to-end PDF reader golden. Do not tune the expected source facts to make the helper pass.

## Reproduction artifacts

- Harness source: `layout-probe.mts`
- Compiled throwaway bundle: `layout-probe-build/layout-probe.mjs` (plus its adjacent PDF.js chunk)
- Node 24 output: `layout-probe-output.json`
- Node 20 and 22 outputs: `layout-probe-output-v20.20.2.json`, `layout-probe-output-v22.23.3.json`
- Source facts: `/workspace/package-e-preparation/pdf-fixtures/layout/generated/expected-source-facts.json`
- Fixture SHA-256: `24e544d672fa4ca336541a6b24c878cee814950f279339c9c9f9e7ab4ec1fef8`
- Source-facts SHA-256: `fc86041da9a45f4e5dabe19f0e4ad1cf732e2a4e3b011762066e3d58b1d30101`

## Reviewed delta follow-up

The published layout delta uses a shared orthogonal quarter-turn text frame for grouping and paragraph layout, then remaps boxes/paragraph-line references to display coordinates. Mixed or unsupported orientations retain separate items in source order. Wide whitespace-only PDF.js gutter items cannot bridge columns. The independent authored PDF/source facts remain unchanged.

Fresh Node24 unpdf1.7/PDF.js5.6.205 result is `layout-probe-output-after.json`, with per-page comparison `layout-probe-comparison-after.json`: **8/10 pages fully preserve authored phrase order, and all expected phrases are present on all10 pages**. Previously mismatching two/three-column pages and the Rotate90 page now match. The two table pages are now column-wise, while the authored table reference is row-wise. No rule/operator adapter exists in this layout helper to distinguish tabular cells from text columns; this needs separate #82/#45 integration. Do not claim all10, a >=95% word-accuracy score, corpus accuracy, or public reader acceptance from this spot check.

Fresh full verify passed503source+13policy+4dist pluslint/types/build/package; focused36tests achieved98.96% line coverage. Tests cover raw-horizontal page rotations90/180/270, pre-rotated upright display text, upside-down glyphs, mixed-orientation fallback, and paragraph split/reference identity invariance. The after-delta output is currently Node24 only; earlier byte-identical Node20/22/24 outputs describe the baseline.

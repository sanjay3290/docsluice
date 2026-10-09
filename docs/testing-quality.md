# Per-format quality scoring

The QA-7 runner compares the built public `extract()` API with source-hash-tied Markdown truths. It reports word recall, table-cell accuracy, and reading-order pair accuracy for each format. It does not trust golden output, generated extraction output, or an unreviewed truth as a quality oracle.

Run it after building the package:

```sh
npm run build
node scripts/quality/run.mjs
node --test scripts/test/quality*.test.mjs
```

The runner reads only `corpus/package-a-truth/**/*.truth.md` and the source files named by those truths. Each source is extracted through `packages/docsluice/dist/index.js`, the public package entry. The JSON report includes every target format (`docx`, `xlsx`, `pptx`, and text `pdf`), its status, metric counts and scores, and the per-file status. It contains paths and scores, not document text.

The truth directory is under `corpus/`, which the QA-2 golden runner walks recursively. Before running that golden suite against the full corpus, its input discovery must exclude `corpus/package-a-truth/` or `.truth.md` files; these are scoring metadata, not extractable documents. This issue does not modify the golden runner.

## Formulas

Text tokenization applies Unicode NFKC normalization, then locale-independent lowercasing, then treats each contiguous run of Unicode letters, numbers, and combining marks as one token. Punctuation and whitespace separate tokens. Word recall is a multiset score across truth text blocks and table cells:

```text
sum(min(truthCount[token], outputCount[token])) / truthTokenCount
```

Repeated words in truth therefore count repeatedly, while extra output copies do not increase recall. If truth has no tokens, the metric is `null` (`n/a`), never a perfect score.

Table cells use explicit zero-based `(table, row, column)` coordinates: `table` is the dense ordinal of a table in the emitted document, and `row`/`column` identify cells in that table's emitted grid. These are not absolute spreadsheet addresses such as `B7`; spreadsheet truth needs a reader-aware mapping before it can make claims about workbook addresses. Truth table ordinals must be contiguous and ordered from zero so a sparse ordinal cannot turn identical output cells into mismatches. Text is compared after NFKC normalization and CRLF-to-LF conversion, preserving case and other whitespace. Accuracy is the count of exact text matches divided by the union of truth and output coordinates. Missing, changed, and extra cells are incorrect. If the truth defines no table cells, the metric is `null` even if output contains tables.

Reading order uses the token sequence from the truth's explicit `readingOrder` references and the output's emitted block/cell order. Each repeated token occurrence is matched to the next output occurrence. The numerator counts pairs of truth tokens whose matched output positions remain in the same order; pairs containing a missing output token are incorrect. The denominator is `n × (n − 1) / 2` for `n` truth tokens. This uses an iterative Fenwick-tree inversion count in `O(n log n)` time and `O(n)` memory, rather than comparing every pair. Fewer than two truth tokens yields `null`.

Each metric report has `correct`, `total`, and `score`; the score is `null` when `total` is zero. Per-format aggregation sums the counts before dividing, so a small file does not receive the same weight as a large truth set.

## Truth files and review state

Truth files use a strict, small Markdown format with YAML-style metadata and three JSON code blocks. The parser allows only the known keys, validates table coordinates and complete reading-order references, caps file and collection sizes, rejects traversal and symlink paths, and verifies the source SHA-256 before extraction.

````markdown
---
schema: docsluice-quality-truth-v1
source: corpus/example/report.docx
sourceSha256: <lowercase SHA-256 of the exact source bytes>
format: docx
reviewStatus: pending
---
## Text blocks

```json
["First paragraph", "Second paragraph"]
```
## Tables

```json
[{"index":0,"cells":[{"row":0,"column":0,"text":"Item"}]}]
```
## Reading order

```json
[{"kind":"text","index":0},{"kind":"cell","table":0,"row":0,"column":0},{"kind":"text","index":1}]
```
````

Only a human who independently checks the original source may set `reviewStatus: reviewed`. Candidate truths in `corpus/package-a-truth/` are explicitly `pending`; their scores are diagnostic and cannot pass a release threshold.

The word-recall release target is at least 98% for DOCX, XLSX, PPTX, and text PDFs. A format passes only when its truth is reviewed, the built public extractor has a real reader for it, extraction produced the expected format, and its aggregate word recall meets the threshold. A scanned PDF marked `needsOcr` cannot pass the text-PDF target. The runner exits `0` only when every target is ready and passes, `1` for invalid truth or a measured failure, and `2` while required truth, human review, or a reader is missing. Statuses such as `missing-truth`, `missing-reader`, and `blocked-unreviewed` are deliberately not converted to scores of 100%.

At this foundation, only the DOC reader is available. The pending DOC sample scores against an independent source-derived candidate, while the DOCX sample reports `missing-reader`; XLSX, PPTX, and PDF report `missing-truth`. The command therefore reports `not-ready` and exits `2`. These are explicit rollout gaps, not passing QA-7 results.

CI and release workflow wiring remains a separate lead-owned integration step. It requires the missing readers, reviewed truth files, and CI/release artifact hooks before this runner can gate or publish release artifacts.

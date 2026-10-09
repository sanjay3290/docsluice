# Chunking

`chunk(document, options)` returns a lazy iterable of chunks from the document's default plain-text rendering. Each chunk has `text`, `headingPath`, `locations`, and a zero-based `index`. Iteration follows the document order and uses the same default traversal limits as `toText()`.

The default strategy is `section`: each heading starts a new chunk section when practical, and entering or leaving a slide or sheet starts a new heading scope. `page` also starts a new chunk at page, slide, or sheet sections. `size` fills chunks by size without forcing heading or page boundaries. All strategies keep each chunk at or below `maxSize`, measured by `countTokens` (or JavaScript string length by default). Text is split at section and block boundaries first, then sentence endings, line breaks, word boundaries, and Unicode code-point boundaries. Sentence boundaries recognize `.`, `!`, and `?` before whitespace and an uppercase letter, as well as the CJK sentence marks `。！？`.

Options are:

| Option | Default | Meaning |
| --- | --- | --- |
| `strategy` | `section` | `section`, `page`, or `size` boundary preference. |
| `maxSize` | `2000` | Maximum measured size of a chunk. Must be finite and greater than zero. |
| `overlap` | `200` (clamped below a smaller `maxSize`) | Measured size of tail text repeated at size splits. |
| `minSize` | `0` | Merge a small final chunk into the previous chunk when both have the same heading path and the result fits. |
| `countTokens` | `text => text.length` | Caller-provided size counter. Each returned value must be finite and nonnegative. |

Overlaps intentionally repeat source text. Set `overlap: 0` when joining chunk text must reproduce `toText(document)` exactly. For a chunk cut inside a block with source offsets, its location is narrowed to the corresponding span; otherwise the block's source location is retained. The heading path includes active headings and enclosing slide or sheet titles.

Table rows remain together when they fit. If a row is too large, cells remain together when possible and oversized cells are split at Unicode code-point boundaries. Chunks containing that row carry a `CHUNK_ROW_SPLIT` warning. Repeated header rows are not added (CHK-4 is out of scope). If one Unicode code point alone measures above `maxSize`, iteration throws `RangeError` because no valid chunk can satisfy the configured limit.

Long blocks use code-point-safe prefix probes, growing the probe only while it fits the size cap. Chunking avoids repeatedly sending the entire remaining paragraph to a caller tokenizer. Custom counters must still return finite, nonnegative values; the single-code-point `RangeError` also applies with custom counters. Standalone chunking enforces its own default output, cell, depth, and time budget.

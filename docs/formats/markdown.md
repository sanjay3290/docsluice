# Markdown

The dependency-free Markdown reader recognizes ATX and setext headings, paragraphs, unordered and ordered lists nested by indentation, fenced and four-space-indented code, GitHub-style pipe tables, and blockquotes. Inline emphasis, strike-through, code spans and link labels become plain text. Link targets are included only as `href` values on paragraph runs when `runs: true`.

Scanning and emitted text are bounded by the shared time, block-depth, and output-character budgets. A list item's parent is the nearest preceding item indented at least two columns less. Items nested deeper than `blockDepth` attach to the deepest allowed parent, and excessive blockquote depth is flattened; both are reported once with `DEPTH_LIMIT`. Truncation never includes source text in warnings.

Nested list items retain their marker strings, but the output model has one ordered flag per list block, so nested ordered and unordered semantics are not represented independently.

This is a small best-effort block parser, not a full CommonMark implementation. It does not resolve references, parse raw HTML, preserve heading/list inline runs, or implement all delimiter and continuation rules. Table alignment markers are ignored; the first row is the table header. URLs are never fetched.

`extract()` loads this reader lazily for `markdown` input. It is also available as the `docsluice/markdown` subpath (`markdownReader`).

## Inline runs (MOD-3)

With `runs: true`, paragraphs keep bold, italic, code and link runs. Emphasis follows CommonMark flanking rules, so an intraword `_` and a spaced `*` stay literal text (see [rendering.md](../rendering.md#inline-runs-mod-3)).

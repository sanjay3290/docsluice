# Markdown

The dependency-free Markdown reader recognizes ATX and setext headings, paragraphs, unordered and ordered lists nested by indentation, fenced and four-space-indented code, GitHub-style pipe tables, and blockquotes. Inline emphasis, strike-through, code spans and link labels become plain text. Link targets are included only as `href` values on paragraph runs when `runs: true`.

Scanning and emitted text are bounded by the shared time, block-depth, and output-character budgets. Excessive list/blockquote depth is flattened and reported with `DEPTH_LIMIT`. Truncation never includes source text in warnings.

This is a small best-effort block parser, not a full CommonMark implementation. It does not resolve references, parse raw HTML, preserve heading/list inline runs, or implement all delimiter and continuation rules. Table alignment markers are ignored; the first row is the table header. URLs are never fetched.

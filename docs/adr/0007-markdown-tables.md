# 0007. Markdown tables: flatten by default, HTML opt-in

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: REN-2, REN-3, PRD Q7

## Context

GitHub-flavoured Markdown tables cannot show merged cells or line breaks inside cells.

## Decision

`toMarkdown(doc, { tables })`:

- `tables: 'flatten'` (default): a merged cell's text goes in its top-left cell; the other covered cells are empty. A line break inside a cell becomes `<br>`. Pipes are escaped as `\|`.
- `tables: 'html'`: a table that has merged cells or multi-line cells is written as an HTML `<table>` with `rowspan`/`colspan`. Simple tables stay pipe tables.

## Consequences

- Default output stays pure GFM except `<br>`, which GitHub and most LLMs read correctly.

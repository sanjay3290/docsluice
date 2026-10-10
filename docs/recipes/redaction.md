# Redaction

The `transform` option sees every block, nested ones included, before any renderer or `onBlock` callback, so masking there covers all output: text, Markdown, JSON and chunks. `metadata: false` drops author names in the same call.

<!-- include: examples/redaction.mjs -->

The patterns are examples; use the ones your data needs. Keep them linear: the e-mail pattern only starts where an address can start, so a long line without an `@` is scanned once.

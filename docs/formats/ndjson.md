# NDJSON

Each non-empty physical line is parsed as one JSON value. Scalar leaves become paragraphs with `record[n]` paths in `loc.path`. Object fields are traversed in source order and arrays by index. A bounded pre-scan charges structural nesting to the shared block-depth budget before calling `JSON.parse`; traversal uses an explicit stack. Malformed records produce a generic `UNREADABLE_PART` warning without source content.

Strings are emitted without JSON quotes, while numbers, booleans, and `null` use their literal text. Empty arrays and objects produce no scalar blocks. Output and depth limits apply.

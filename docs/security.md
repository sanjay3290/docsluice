# Security model

docsluice is built to read files from strangers. Every defence is on by default and cannot be switched off by a file.

| Threat | Defence |
| --- | --- |
| Zip bombs | Bytes are counted as they decompress, against a total and a per-entry compression-ratio limit. Sizes written in the archive are never trusted. |
| Archives with huge entry counts | An entry-count limit, checked before entries are read. |
| Path tricks (`../../etc/passwd`) | docsluice never writes to disk; entry names are plain strings. |
| XML external entities and billion laughs | One XML parser for everything, with DTDs, external entities and processing instructions off and not switchable; only the five built-in entities. |
| Prototype pollution | File data is never used as a plain-object key: `Map`, `Set` and null-prototype records only. A lint rule enforces it. |
| Slow regular expressions | No super-linear pattern runs on file data; hot paths use hand-written scanners. Checked by `eslint-plugin-regexp`. |
| Deep nesting | Depth limits everywhere, and explicit stacks instead of recursion over file data. |
| Endless loops | Visited sets on every reference graph, and a time budget for the whole extraction. |
| Network access | docsluice never fetches anything. Linked images, templates and external relationships are reported as data (`features.hasExternalLinks`). |
| Running content | Macros, scripts, PDF JavaScript and formulas are never run. Their presence is reported (`hasMacros`, `hasJavaScript`); formula text is a string. |
| Memory exhaustion | Limits on cells, characters, entries, bytes and depth, shared by a document and all its children. Sparse storage for sheets. |
| A crash in one parser | `docsluice/worker` runs extraction in a worker thread with a memory cap and kills it on timeout. See [worker isolation](worker.md). |
| Supply chain | One runtime dependency (`fflate`), pinned. No install scripts anywhere in the tree. |

## What you still decide

- **Limits.** The defaults suit a server that takes uploads. Lower them for untrusted input with a tight time budget, and use `onLimit: 'throw'` when a partial result is not useful. See the [upload recipe](recipes/upload.md).
- **Personal data.** `metadata: false` drops author names, comment authors and image GPS. A `transform` can mask text; see the [redaction recipe](recipes/redaction.md).
- **Isolation.** Parsing runs in your process unless you use `docsluice/worker`.

Errors and warnings never contain document content: format ids, limit names, counts and paths only. They are safe to log and to return to a client.

Every reader is tested against a corpus of hostile files (bombs, loops, deep nesting, prototype-named keys, broken structures) and fuzzed in CI. See [testing](testing.md).

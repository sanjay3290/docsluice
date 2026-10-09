# Security model

docsluice processes file bytes supplied by your application. The library makes no network requests, runs no macros, formulas, scripts, or embedded content, and emits no content logs. Treat names, text, metadata, URLs, and archive entry names from a document as untrusted input.

## Budgets

Extraction has defaults for input bytes, total uncompressed bytes, compression ratio, archive entries, child depth, XML depth, block depth, output characters, spreadsheet cells, PDF pages, and elapsed time. See the [generated limits table](/reference/limits). Overrides apply per extraction. A caller-provided `AbortSignal` can cancel work.

Input size and compression-ratio violations always throw. Other resource limits follow `onLimit: 'truncate'` (default) or `onLimit: 'throw'`. Truncation returns accepted partial output with a warning and `stats.truncated`; readers share resource counters with child documents.

## Privacy and boundaries

`metadata: false` drops supported personal metadata. A `transform` callback receives blocks before renderers and is the place to apply application-specific redaction. The example masks a conservative email shape and US SSN-style ID pattern from visible block text; it cannot certify legal compliance and does not redact arbitrary metadata or external application state. Review the transform for your data and threat model.

The core uses web-standard APIs. The `docsluice/node` subpath currently re-exports the root API and does not add filesystem, stream, or worker helpers; those integrations are pending issues #19 and #62. The default extraction registry currently contains only the legacy DOC reader; container/XML utilities and format detection do not imply that content is extracted. A future deployment to GitHub Pages needs an owner-selected repository base path and publishing policy; this change only builds static files locally/CI.

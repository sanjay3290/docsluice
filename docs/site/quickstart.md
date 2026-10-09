# Quick start

Install the `docsluice` package and use its browser-standard `extract` and `toMarkdown` APIs. For a complete, tested path with real input bytes, bounded options, redaction, rendered Markdown, and citation locations, start from the [RAG ingestion module](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/rag.ts) and its [integration test](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/test/docs/site.test.ts).

In this foundation the registered reader handles legacy Word `.doc` files. `extract` reports `UNSUPPORTED_FORMAT` for other recognized types without a registered reader. The detector recognizing a format does not imply a content reader exists. Check [format status](/formats/).

For a server-side upload, apply a size/time budget, disable author metadata when it is not needed, and pass a transform that redacts blocks before they reach the rest of your application. The runnable examples are [upload handling](/recipes/upload), [RAG ingestion](/recipes/rag), [redaction](/recipes/redaction), and [OCR routing](/recipes/ocr).

The `docsluice/node` subpath currently re-exports the root API; it does not yet add filesystem, stream, or worker helpers. Those integrations are pending issues #19 and #62. The CLI (`docsluice`) is tracked separately in issue #63 and is not part of this foundation yet.

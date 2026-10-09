# RAG ingestion

The [runnable source](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/examples/site/rag.ts) extracts with bounded settings and redacts blocks before rendering Markdown and collecting citations. Its complete invocation is exercised against the checked-in fixture by the [recipe test](https://github.com/sanjay3290/docsluice/blob/fix/package-a-docs-site/packages/docsluice/test/docs/site.test.ts). Feed the returned `{ markdown, citations }` into your own index adapter; this repository does not currently export a chunking or vector-store API.

The integration test uses the checked-in self-authored legacy DOC fixture. That proves the current reader path only; other formats must be added to the registry before this recipe can ingest them.

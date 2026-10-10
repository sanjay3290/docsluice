# RAG ingestion

Split a document into chunks for a vector index. Each chunk keeps its heading path, which gives a short piece of text its context, and the locations of its source, for citations. Pass your embedding model's tokenizer as `countTokens` so `maxSize` is in tokens.

<!-- include: examples/rag.mjs -->

Tables are split by rows and repeat their header row in every piece, so a chunk of a table still says what its columns mean.

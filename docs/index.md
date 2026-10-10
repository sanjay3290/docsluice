# docsluice

Safe, structured document extraction for every JavaScript runtime. One call gives text, Markdown, tables, page, slide and sheet locations, and metadata from office, PDF, web, email and archive files. Limits are on by default, so it is safe on files from strangers. It has no native code, and runs in Node.js 20+, Bun, Deno, browsers and edge workers.

```js
import { extract, toMarkdown } from 'docsluice';

const doc = await extract(bytes, { filename: 'report.docx' });
console.log(toMarkdown(doc));
```

## Start here

- [Quick start](quickstart.md): install, extract, render, chunk.
- [Security model](security.md): what docsluice defends against, and how.
- [Limits](limits.md): every limit and its default.
- [Recipes](recipes/index.md): RAG ingestion, handling uploads, redaction, OCR.

## Reference

- [Formats](formats/support-matrix.md): what each reader supports, with one page per format.
- [Rendering](rendering.md): text, Markdown, JSON, table records and chunks.
- [Format plugins](plugins.md): teach docsluice a new format; the exported building blocks.
- [Node.js](node.md), [worker isolation](worker.md) and [the command line](cli.md).
- [API reference](api/index.html): every export, from the TSDoc comments.

## Design

- [Architecture](architecture.md), [testing](testing.md), [requirements](prd.md) and the [decision records](adr/README.md).

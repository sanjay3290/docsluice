# Quick start

## Install

```sh
npm install docsluice
```

docsluice is ESM and CommonJS, with types. It needs no native modules and no install scripts.

## Extract

`extract()` takes bytes (`Uint8Array`, `ArrayBuffer`), a `Blob` or a `ReadableStream`. In Node, `extractFile()` from `docsluice/node` reads a path. The format comes from the content; a file name or MIME type is only a hint.

```js
import { extract } from 'docsluice';

const doc = await extract(bytes, { filename: 'q3.xlsx' });
doc.format; // 'xlsx'
doc.blocks; // headings, paragraphs, lists, tables, images, notes, sections…
doc.metadata; // title, authors, dates
doc.warnings; // what was skipped or guessed, never document content
```

Every block has a `loc`: its page, slide, sheet and range, or part path, plus its offsets in the text output, for citations.

## Render

```js
import { toJSON, toMarkdown, toText } from 'docsluice';

toText(doc); // plain text, blank lines between blocks
toMarkdown(doc); // GitHub Markdown; tables stay tables
toJSON(doc, { stable: true }); // stable key order, for snapshots
```

## Chunk for search and language models

```js
import { chunk } from 'docsluice';

for (const piece of chunk(doc, { maxSize: 1_000, overlap: 100 })) {
  index.add({ text: piece.text, context: piece.headingPath.join(' › '), loc: piece.locations });
}
```

A table split across chunks repeats its header row in every piece.

## Options you will use

| Option | What it does |
| --- | --- |
| `limits` | Lower or raise any [limit](limits.md) for one call. |
| `onLimit` | `'truncate'` (default) keeps what was read and warns; `'throw'` fails instead. |
| `signal` | An `AbortSignal` to cancel. |
| `metadata: false` | Drop authors and other personal metadata. |
| `children` | `'extract'` (default), `'list'` or `'skip'` for attachments and archive entries. |
| `runs: true` | Keep bold, italic, code and link runs on paragraphs. |
| `transform` | Change or drop every block before it is rendered, for example to [redact](recipes/redaction.md). |
| `headerRow`, `formulas`, `revisions`, `includeHidden`, `mainContent` | Format-specific switches; see the [format pages](formats/support-matrix.md). |

## Stream big files

`extractStream()` gives blocks as they are read, with backpressure:

```js
import { extractStream } from 'docsluice';

const stream = extractStream(bytes, { filename: 'big.csv' });
for await (const block of stream) handle(block);
const doc = await stream.result;
```

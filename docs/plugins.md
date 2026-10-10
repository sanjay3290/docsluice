# Format plugins

A format plugin teaches docsluice a format it does not read itself (EXT-4). A plugin is a plain object with an id, the reader contract version it was built for, optional hints and probe, and a `read` function. It runs inside the caller's extraction: the same shared budget, limits, abort signal, warning policy and nested-file handling as the built-in readers.

## A full example

```ts
import { createRegistry, extract, READER_CONTRACT_VERSION, toMarkdown } from 'docsluice';
import type { FormatPlugin, ReadContext } from 'docsluice';

const MAGIC = 'TALLY\n';

/** A made-up format: a `TALLY` line, then `item=count` lines. */
const tallyPlugin: FormatPlugin = {
  id: 'tally',
  contract: READER_CONTRACT_VERSION, // '1.0.0'
  mimeTypes: ['application/x-tally'],
  extensions: ['tally'],

  // Optional, synchronous and bounded: look at a prefix only.
  detect(bytes) {
    for (let index = 0; index < MAGIC.length; index++) {
      if (bytes[index] !== MAGIC.charCodeAt(index)) return 0;
    }
    return 1;
  },

  async read(ctx: ReadContext) {
    const text = new TextDecoder().decode(ctx.bytes);
    const rows = [[{ text: 'Item' }, { text: 'Count' }]];
    for (const line of text.split('\n').slice(1)) {
      ctx.budget.tick(); // abort and time checks
      const equals = line.indexOf('=');
      if (equals < 0) continue;
      if (!ctx.budget.addCells(2)) break; // shared cell limit: stop, the budget warns TRUNCATED
      rows.push([{ text: line.slice(0, equals) }, { text: line.slice(equals + 1) }]);
    }
    ctx.out.table(rows, 1, ctx.path ? { path: ctx.path } : {});
  },
};

const registry = createRegistry(); // built-in readers, plus anything you register here
registry.registerFormat(tallyPlugin);

const doc = await extract(bytes, { registry, filename: 'fruit.tally' });
console.log(doc.format); // 'tally'
console.log(toMarkdown(doc));
```

`registerFormat(plugin)` (exported from `docsluice`) registers on the default registry that `extract()` uses without a `registry` option. Libraries should prefer `createRegistry()`, so they do not change global state for other code in the same process.

## Plugin fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | The format id reported as `doc.format`. It must not be a built-in id or one already registered on that registry (`TypeError`). |
| `contract` | yes | The reader contract version the plugin was built for (`"1.0.0"`). See below. |
| `mimeTypes` | no | MIME types. The first is reported as `doc.mimeType` (default `application/octet-stream`). |
| `extensions` | no | File extensions without the dot, matched case-insensitively against the `filename` option. |
| `detect(bytes)` | no | A synchronous probe returning a confidence from 0 to 1. It should look at a bounded prefix only. If it throws, it counts as 0. |
| `read(ctx)` | yes | Reads the document into `ctx.out`. |

## How a plugin is chosen

1. A forced `format` option always wins, and may name a plugin id.
2. Built-in detection runs first (magic bytes, archive structure, text sniffing).
3. A plugin whose extension or MIME type matches the caller's `filename` or `mimeType` hint is chosen, unless its `detect` returns 0.
4. Otherwise, only when built-in detection is not confident (below 0.9, for example unknown binary data or plain text), every plugin's `detect` runs, and the highest confidence above the built-in one wins. Ties go to the plugin registered first.

The same registry is used for child documents, so a plugin format inside a zip or an email attachment is read by the plugin too.

## What `read` gets

`ReadContext` is the same object built-in readers get:

- `bytes`, `filename`, `options` (the resolved extraction options) and `path` (the child path prefix, `''` for the root document).
- `budget`: the shared `Budget`. Call `budget.tick()` in every loop over file data; charge `addCells`, `addOutputChars`, `addUncompressed` as you work and stop when they return `false`. A child cannot reset its parent's allowances.
- `warnings`: add structural warnings (`{ code, message }`). Messages must not contain document content.
- `out`: the `DocBuilder` (`heading`, `paragraph`, `list`, `table`, `code`, `image`, `note`, `headerFooter`, `openSection`/`closeSection`, `setMetadata`, `setFeature`, `addChild`). It applies `transform`, `onBlock`, output limits and depth flattening.
- `extractChild(name, bytes, hint?)`: read an embedded file as a child document under the shared budget, with nesting depth and self-containing-file checks.

The safe helpers are exported for plugins too: `openZip` (bounded ZIP index and streaming inflate), `scanXml` and `parseXml` (SAX and tree XML without DTDs or external entities), and `Budget`/`WarningSink`.

## Errors

- A plugin whose `read` throws anything other than a `DocsluiceError` makes `extract()` reject with `CorruptFileError` (`CORRUPT_FILE`); the original error is its `cause`. `DocsluiceError`s (limits, abort, timeout, strict warnings) pass through unchanged.
- Registering a plugin built for an incompatible contract throws `PluginContractError` (code `PLUGIN_INCOMPATIBLE`), with the plugin's `plugin` id and requested `contract`.

## Contract versions (EXT-7)

`READER_CONTRACT_VERSION` is the version of the plugin contract this docsluice provides, currently `1.0.0`. It changes independently of the package version:

- a new major version means a breaking change to `ReadContext`, `DocBuilder` or plugin fields;
- a new minor version adds something plugins may use.

A plugin is accepted when its `contract` has the same major version and a minor version no newer than the one provided (`1.0.x` works with `1.0.0`; `1.1.0` and `2.0.0` are refused). The value must be a plain `major.minor.patch` string.

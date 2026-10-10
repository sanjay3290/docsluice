# Plain-text rendering

`toText(document)` renders block content in order, with a blank line between sibling blocks. Headings, paragraphs, code, notes, headers, footers, and image alt text render as plain text. Lists put one item on each line, using the stored marker or a deterministic default (`•` for unordered lists and `1.`, `2.`, … for ordered lists); each nested level adds two spaces. Tables use tabs between cells and line breaks between rows. A section adds no title or marker; its child blocks render in order.

Extracted child documents are omitted by default. Pass `{ children: true }` to append each extracted child after its path on a separate line. This changes the output positions of later text. `loc.offset` values point into the default `toText(document)` result, so compute offsets again if you render with options that add or change text.

`toText` processes block data under the default renderer limits for output characters (20 million), table cells (2 million), block nesting (64), child-document depth (3), and elapsed time (60 seconds). It throws the corresponding limit error instead of returning partial text. It also rejects active child-document cycles.

## JSON and its schema (REN-4, MOD-2)

`toJSON(doc)` writes the document with a stable key order. `{ stable: true }` sets `stats.durationMs` to 0 for snapshots, and `{ bytes: 'base64' }` includes raw child bytes, which are left out by default. The output follows a JSON Schema (draft 2020-12) shipped with the package as `docsluice/schema.json`, so tools in any language can validate docsluice JSON:

```js
import schema from 'docsluice/schema.json' with { type: 'json' };
```

- The schema is generated from `src/core/model.ts` at build time (`scripts/generate-schema.mjs`), with the TSDoc comments as `description`s, so it cannot drift from the types.
- `$id` names the model's major version (`urn:docsluice:schema:document:v0`); a breaking model change is a new major version (MOD-1).
- Objects reject unknown properties. Format ids and warning codes are open strings, because plugins add their own; the known values are listed as `examples`. Child `bytes` are base64 strings.
- Every reviewed golden JSON file in the corpus validates against it in CI (`test/core/schema.test.ts`, with Ajv).

## Inline runs (MOD-3)

With `runs: true`, paragraphs carry `runs`: their text cut into pieces with `bold`, `italic`, `code` and `href`. Runs are off by default to keep output small.

- The runs of a paragraph always join to exactly its `text`. Neighbouring runs with the same formatting are merged, and empty runs are dropped.
- **HTML:** `b`/`strong` (bold), `i`/`em`/`cite`/`dfn`/`var` (italic), `code`/`kbd`/`samp`/`tt` (code), and `a href` (link).
- **Markdown:** `**`/`__` (bold) and `*`/`_` (italic), by CommonMark's flanking rules, so `snake_case` and `2 * 3` stay literal. Also code spans, and links, whose labels may hold emphasis.
- **DOCX:** `w:b` and `w:i`, hyperlinks, and code: a character style whose id or name mentions code or verbatim (`HTMLCode`, `Verbatim Char`), or a monospace font set on the run (`Courier New`, `Consolas`, …).
- **RTF and ODT:** bold, italic and links (see their format pages).
- `toMarkdown` writes runs as Markdown (`**bold**`, `*italic*`, `` `code` ``, `[text](href)`); `toText` ignores them.

## Table records (REN-5)

`toRecords(table)` turns a `table` block into one record per row after its `headerRows` header rows:

```ts
import { extract, toRecords } from 'docsluice';

const doc = await extract(bytes);
const sheet = doc.blocks.find((block) => block.kind === 'section');
const table = sheet?.kind === 'section' ? sheet.blocks.find((block) => block.kind === 'table') : undefined;
if (table?.kind === 'table') console.log(toRecords(table)); // [{ Item: 'Pump', Cost: '120' }, …]
```

- Keys come from the last header row. An empty header cell takes the name of a merged header cell that spans it; any other empty one is named by its position (`column4`). A table with `headerRows: 0` has positional keys only.
- Repeated names get a suffix: `name`, `name_2`, `name_3`.
- Every record has every column as a key; values are the cells' `text`, and missing cells are `''`.
- Records have a `null` prototype (SEC-6), so a header named `__proto__` or `constructor` is an ordinary key and cannot reach `Object.prototype`. Spread a record (`{ ...record }`) when you need a plain object.

## Chunks (CHK-1, CHK-2, CHK-3, CHK-4)

`chunk(doc, options)` splits a document into pieces for search indexes and language models. It returns a lazy generator: chunks are built as you iterate, so a large document never holds all of them at once. The same document and options always give the same chunks.

```ts
import { chunk, extract } from 'docsluice';

for (const piece of chunk(doc, { maxSize: 2_000, overlap: 200, countTokens })) {
  index.add({ text: piece.text, headingPath: piece.headingPath, loc: piece.locations });
}
```

Options:

| Option | Default | Meaning |
|--------|---------|---------|
| `strategy` | `'section'` | `section` starts a new chunk at every heading and every page, slide or sheet; `page` only at pages, slides and sheets; `size` cuts only where a chunk is full. |
| `maxSize` | 2,000 | Largest chunk, measured by `countTokens`. |
| `overlap` | 200 | Text repeated from the end of the previous chunk; at most half of `maxSize`. |
| `minSize` | 0 | A section smaller than this is merged into the next chunk instead of becoming its own. |
| `countTokens` | text length | Size of a text, for example in model tokens (CHK-2). docsluice has no tokenizer of its own. |

Each chunk is `{ index, text, headingPath, locations, overlap, warnings? }`:

- `text` is a slice of the default `toText(doc)` output (child documents are not included). Removing each chunk's first `overlap` characters and joining the rest gives the `toText` output again, apart from the separators at the cuts.
- `overlap` is the length of the repeated text at the start: text from the end of the previous chunk, or a table's header rows (CHK-4).
- `headingPath` lists the enclosing headings and the slide, sheet or part titles, outermost first (`['Chapter 2', 'Pricing']`). It is taken at the chunk's first non-heading text, so a chunk that starts with a heading includes it. A slide's title heading is not listed twice.
- `locations` are copies of the `loc` of every block the chunk's text comes from, in order.

Cutting rules:

- A chunk is cut at the strongest break near its end, in this order: a section boundary (a heading, or the start of a page, slide or sheet), a block boundary, a sentence end, a line break, a word boundary, and last a hard cut by characters (never inside a surrogate pair). "Near the end" means the first part keeps at least half of `maxSize` when such a break exists.
- A sentence ends at `.`, `!` or `?` (after any closing quotes or brackets) followed by white space and an upper-case letter or a digit, or at `。`, `！`, `？`. The splitter is a hand-written scanner.
- Table rows are lines, and a row that fits `maxSize` is never split. A row longer than `maxSize` is split at cell boundaries (and inside cells when one cell is too long), and that chunk carries `warnings: ['A table row longer than maxSize was split at cell boundaries.']`.
- A table split across chunks repeats its header rows (`headerRows`) at the start of every later piece (CHK-4). The repeated rows count in `overlap` and replace the ordinary overlap for that chunk, so every piece of the table reads as a table with its column names. The caption is not repeated. A header longer than half of `maxSize` is not repeated, so a chunk always has room for data.
- A chunk made only of headings is not cut at the next heading, so a heading stays with its text.
- Overlap is made of whole sentences (or lines, rows and words when the text was split finer) from the end of the previous chunk, and never crosses a forced section boundary.
- With a custom `countTokens`, sizes are added piece by piece and every finished chunk is measured again; if a counter is not additive and the whole text is too long, its last pieces move to the next chunk.

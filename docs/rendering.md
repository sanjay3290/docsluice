# Plain-text rendering

`toText(document)` renders block content in order, with a blank line between sibling blocks. Headings, paragraphs, code, notes, headers, footers, and image alt text render as plain text. Lists put one item on each line, using the stored marker or a deterministic default (`•` for unordered lists and `1.`, `2.`, … for ordered lists); each nested level adds two spaces. Tables use tabs between cells and line breaks between rows. A section adds no title or marker; its child blocks render in order.

Extracted child documents are omitted by default. Pass `{ children: true }` to append each extracted child after its path on a separate line. This changes the output positions of later text. `loc.offset` values point into the default `toText(document)` result, so compute offsets again if you render with options that add or change text.

`toText` processes block data under the default renderer limits for output characters (20 million), table cells (2 million), block nesting (64), child-document depth (3), and elapsed time (60 seconds). It throws the corresponding limit error instead of returning partial text. It also rejects active child-document cycles.

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

## Chunks (CHK-1, CHK-2, CHK-3)

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
- `headingPath` lists the enclosing headings and the slide, sheet or part titles, outermost first (`['Chapter 2', 'Pricing']`). It is taken at the chunk's first non-heading text, so a chunk that starts with a heading includes it. A slide's title heading is not listed twice.
- `locations` are copies of the `loc` of every block the chunk's text comes from, in order.

Cutting rules:

- A chunk is cut at the strongest break near its end, in this order: a section boundary (a heading, or the start of a page, slide or sheet), a block boundary, a sentence end, a line break, a word boundary, and last a hard cut by characters (never inside a surrogate pair). "Near the end" means the first part keeps at least half of `maxSize` when such a break exists.
- A sentence ends at `.`, `!` or `?` (after any closing quotes or brackets) followed by white space and an upper-case letter or a digit, or at `。`, `！`, `？`. The splitter is a hand-written scanner.
- Table rows are lines, and a row that fits `maxSize` is never split. A row longer than `maxSize` is split at cell boundaries (and inside cells when one cell is too long), and that chunk carries `warnings: ['A table row longer than maxSize was split at cell boundaries.']`. Repeating header rows in each piece (CHK-4) is not done yet.
- A chunk made only of headings is not cut at the next heading, so a heading stays with its text.
- Overlap is made of whole sentences (or lines, rows and words when the text was split finer) from the end of the previous chunk, and never crosses a forced section boundary.
- With a custom `countTokens`, sizes are added piece by piece and every finished chunk is measured again; if a counter is not additive and the whole text is too long, its last pieces move to the next chunk.

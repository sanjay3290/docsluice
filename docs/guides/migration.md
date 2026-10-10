# Migrating to docsluice

This guide is for applications that read uploaded files with one library per format: SheetJS (`xlsx`) for spreadsheets, `pdf-parse` for PDFs, `mammoth` for Word files, and `adm-zip` or `yauzl` for archives. It shows how each job maps to docsluice and what behaves differently.

The short version: one `extract()` call reads any supported file into one result shape, under limits that are on by default. Renderers turn that result into Markdown or plain text for a language model, and every block carries a location for citations.

Every `ts` sample below runs in the test suite (`packages/docsluice/test/docs/guides.test.ts`) against files from the repository's test corpus. The `js` "before" snippets show the other libraries' public calls in outline and are not run.

## One call for any file

Before, each format had its own entry point and its own output:

```js
// Before (outline): a different call and result per format.
const workbook = XLSX.read(buffer); // SheetJS: workbook object
const { value } = await mammoth.extractRawText({ buffer }); // mammoth: a string
const { text } = await pdfParse(buffer); // pdf-parse: a string
const entries = new AdmZip(buffer).getEntries(); // adm-zip: entry objects
```

With docsluice, the format is detected from the bytes (the file name and MIME type are only hints) and every file gives a `DocsluiceDocument`:

```ts
import { extractFile, toMarkdown, toText } from 'docsluice/node';

for (const path of ['report.xlsx', 'letter.docx', 'deck.pptx']) {
  const doc = await extractFile(path);
  const markdown = toMarkdown(doc); // headings, lists and pipe tables for a model
  const text = toText(doc); // plain text, tab-separated table cells
  if (markdown.length === 0 || text.length === 0) throw new Error(`${doc.format}: no text`);
}
```

In browsers, Deno, Bun and edge workers, use `extract(bytes)` from `docsluice` with a `Uint8Array`, `ArrayBuffer`, `Blob` or `ReadableStream`.

## Spreadsheets (from SheetJS)

| SheetJS                         | docsluice                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------- |
| `XLSX.read(buffer)`             | `extract(bytes)` or `extractFile(path)`                                                   |
| `workbook.SheetNames`           | sections with `role: 'sheet'`; `title` and `loc.sheet` are the sheet name                 |
| hidden sheet state              | `section.hidden` is `true` or `'very'`                                                    |
| `sheet_to_json`, `sheet_to_csv` | `table.rows`: a grid of cells with `text` (formatted), `raw` (stored value) and `address` |
| cell `.w` / `.v`                | `cell.text` / `cell.raw`                                                                  |
| cell `.f`                       | `cell.formula`, only with `formulas: true`; formulas are never calculated                 |
| merged cells (`!merges`)        | `rowSpan` / `colSpan` on the top-left cell                                                |

```ts
import { extractFile } from 'docsluice/node';
import type { Block } from 'docsluice';

const doc = await extractFile('report.xlsx', { formulas: true });
for (const block of doc.blocks) {
  if (block.kind !== 'section' || block.role !== 'sheet') continue;
  const sheetName = block.title ?? '';
  for (const table of block.blocks.filter(
    (child): child is Extract<Block, { kind: 'table' }> => child.kind === 'table',
  )) {
    for (const row of table.rows) {
      for (const cell of row) {
        if (cell.text === '') continue;
        const citation = `${sheetName}!${cell.address ?? ''}`; // for example "Data!B7"
        if (!citation.includes('!')) throw new Error('no address');
      }
    }
  }
}
```

Differences to know:

- Sparse sheets are not padded to their `dimension`: a value in A1 and one in Z90000 give two small tables, not one with millions of empty cells.
- Number formats are applied the way Excel shows them (dates in the 1900 and 1904 systems, percentages, currency); `raw` keeps the stored number. Month names are English and output never depends on the host locale or time zone.
- There is no write support. docsluice only reads.
- Header-row detection and row-to-object records are planned (XLS-8, REN-5). Until then, take the first row as headers yourself:

```ts
import { extractFile } from 'docsluice/node';

const doc = await extractFile('report.xlsx');
const sheet = doc.blocks[0];
const table = sheet?.kind === 'section' ? sheet.blocks.find((block) => block.kind === 'table') : undefined;
if (table?.kind === 'table') {
  const [header = [], ...rows] = table.rows;
  // Arrays of [name, value] pairs, so cell text never becomes an object key.
  const records = rows.map((row) =>
    row.map((cell, index) => [header[index]?.text ?? `column ${index + 1}`, cell.text]),
  );
  if (records.length === 0) throw new Error('no records');
}
```

## Word documents (from mammoth)

| mammoth                               | docsluice                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `extractRawText({ buffer })`          | `toText(await extract(bytes))`                                                                    |
| `convertToHtml` / `convertToMarkdown` | `toMarkdown(doc)` (Markdown, not HTML)                                                            |
| style maps for headings               | built-in and custom heading styles become `heading` blocks with levels                            |
| images (`convertImage`)               | `image` blocks with `alt`, size and `ref`; image bytes as child documents with `childBytes: true` |
| messages                              | `doc.warnings`: codes and counts, never document content                                          |

```ts
import { extractFile, toMarkdown } from 'docsluice/node';

const doc = await extractFile('letter.docx', { childBytes: true });
const markdown = toMarkdown(doc);
const images = doc.children.filter((child) => child.mimeType?.startsWith('image/'));
for (const image of images) {
  if (!(image.bytes instanceof Uint8Array)) throw new Error('image bytes missing');
}
if (!markdown.includes('#')) throw new Error('no headings');
```

Tracked changes are accepted by default; pass `revisions: 'reject'` or `'show'` to see the other view. Footnotes, endnotes and comments are `note` blocks next to the paragraph that references them; with `metadata: false` comment authors are removed.

## PDFs (from pdf-parse)

The PDF reader arrives with milestone M2. Until then, `extract()` detects a PDF and throws `UnsupportedFormatError` (code `UNSUPPORTED_FORMAT`), so keep your PDF path for now and switch when the reader ships. The mapping will be:

| pdf-parse                  | docsluice (M2)                                                   |
| -------------------------- | ---------------------------------------------------------------- |
| `data.text`                | `toText(doc)`                                                    |
| `data.numpages`            | `doc.metadata.pageCount`; one `section` per page with `loc.page` |
| `data.info`                | `doc.metadata`                                                   |
| scanned pages without text | `doc.stats.needsOcr` and per-page `needsOcr`                     |

```ts
import { detect, UnsupportedFormatError, extract } from 'docsluice';

const pdf = new TextEncoder().encode('%PDF-1.7\n%âãÏÓ\n');
const { format } = await detect(pdf);
try {
  await extract(pdf);
} catch (error) {
  // Keep the existing PDF path for now.
  if (!(error instanceof UnsupportedFormatError) || format !== 'pdf') throw error;
}
```

## Archives (from adm-zip and yauzl)

docsluice reads a plain zip as a document with one child per entry, in central-directory order. Each child is detected and read like a top-level file, so an archive of spreadsheets gives you their sheets directly. Children share the parent's limits, so a nested bomb cannot reset the byte, entry, time or output budget.

| adm-zip / yauzl                      | docsluice                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `getEntries()` / `readEntry` loop    | `doc.children` (`path`, `name`, `status`, `sizeBytes`, `mimeType`)                                      |
| `entry.getData()` / `openReadStream` | `children: 'extract'` (default) reads each entry as a document; `childBytes: true` also keeps its bytes |
| listing only                         | `children: 'list'`: no entry data is read                                                               |
| `isDirectory`, junk files            | `status: 'skipped'` (`__MACOSX/`, `.DS_Store`, `Thumbs.db`)                                             |
| encrypted entries                    | `status: 'failed'` with error code `ENCRYPTED`, and `features.isEncrypted`                              |
| writing files to disk                | never: names are display strings only, so `../../etc/passwd` cannot escape                              |

```ts
import { extractFile } from 'docsluice/node';
import type { ChildDocument, DocsluiceDocument } from 'docsluice';

const listing = await extractFile('uploads.zip', { children: 'list' });
const names = listing.children.map((child) => child.path);

const doc = await extractFile('uploads.zip');
// Walk nested archives with an explicit stack.
const stack: DocsluiceDocument[] = [doc];
const extracted: ChildDocument[] = [];
while (stack.length > 0) {
  const current = stack.pop()!;
  for (const child of current.children) {
    if (child.status === 'extracted' && child.document) {
      extracted.push(child);
      stack.push(child.document);
    }
  }
}
if (names.length === 0 || !extracted.some((child) => child.path === 'inner.zip/notes.txt'))
  throw new Error('nested file missing');
```

If you need raw entry bytes without document parsing, the safe ZIP index is exported on its own:

```ts
import { readFile } from 'node:fs/promises';
import { Budget, DEFAULT_LIMITS, openZip } from 'docsluice';

const archive = openZip(new Uint8Array(await readFile('uploads.zip')), new Budget(DEFAULT_LIMITS));
for (const entry of archive.entries) {
  if (entry.name.endsWith('/') || entry.isUnreadable) continue;
  const bytes = await archive.read(entry); // inflated under the byte and ratio limits; null if unreadable
  if (bytes === null) throw new Error(`could not read ${entry.name}`);
}
```

## Shared limits and errors

Limits are on by default (input size, uncompressed bytes, compression ratio, zip entries, nesting depth, XML depth, cells, output characters, time). Set them once per call; nested files share them.

```ts
import { DocsluiceError, extractFile } from 'docsluice/node';

try {
  const doc = await extractFile('uploads.zip', {
    limits: { inputBytes: 25_000_000, totalUncompressedBytes: 100_000_000, timeMs: 15_000 },
    signal: AbortSignal.timeout(20_000),
  });
  if (doc.stats.truncated) {
    // A limit cut the output short; doc.warnings says which, with counts only.
  }
} catch (error) {
  if (!(error instanceof DocsluiceError)) throw error;
  // error.code: UNSUPPORTED_FORMAT, ENCRYPTED, CORRUPT_FILE, LIMIT_EXCEEDED, TIMEOUT, ABORTED, ...
}
```

Behaviour differences: a compression-ratio bomb always throws `LIMIT_EXCEEDED`; other limits truncate with a `TRUNCATED` warning unless you pass `onLimit: 'throw'`. Macros, scripts and formulas are never run; their presence is reported in `doc.features`.

## Redaction before a language model

Run redaction in the `transform` hook. It sees every block of every format, including blocks inside nested files, before any renderer:

```ts
import { extractFile, toMarkdown } from 'docsluice/node';
import type { Block } from 'docsluice';

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/gu;
const mask = (text: string) => text.replace(EMAIL, '[email]');

function redact(block: Block): Block {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
    case 'code':
    case 'note':
    case 'header':
    case 'footer':
      return { ...block, text: mask(block.text) };
    case 'table':
      return {
        ...block,
        rows: block.rows.map((row) => row.map((cell) => ({ ...cell, text: mask(cell.text) }))),
      };
    case 'list':
      return { ...block, items: block.items.map((item) => ({ ...item, text: mask(item.text) })) };
    default:
      return block;
  }
}

const doc = await extractFile('letter.docx', { transform: redact, metadata: false });
const markdown = toMarkdown(doc); // what you send to the model
if (/[\w.+-]+@[\w-]+\.[\w.-]+/u.test(markdown)) throw new Error('an email address was not masked');
```

`metadata: false` also removes authors and custom properties. (Nested list items are left as they are in this short example; a real redactor walks them too.)

## Markdown for the model, locations for citations

`chunk()` splits a document into pieces of a given size for search or a model's context, each with its heading path and the locations of its text:

```ts
import { chunk, extractFile } from 'docsluice/node';

const doc = await extractFile('deck.pptx');
const pieces = [];
for (const piece of chunk(doc, { maxSize: 500, overlap: 50 })) {
  pieces.push({
    text: piece.text,
    heading: piece.headingPath.join(' › '), // "Two columns"
    cite: piece.locations.map((loc) => (loc.slide !== undefined ? `slide ${loc.slide}` : (loc.path ?? ''))),
  });
}
if (pieces.length === 0) throw new Error('no chunks');
```

Every block has `loc`: `page`, `slide`, `sheet` and `range`, `path` (the child path inside archives, such as `inner.zip/notes.txt`) and `offset` (its span in `toText(doc)`). Pass a `countTokens` function to measure chunks in your model's tokens.

## Checklist

1. Replace the per-format calls with `extract()` (or `extractFile()` in Node) behind a flag.
2. Move redaction into `transform`.
3. Send `toMarkdown(doc)` or `chunk(doc)` text to the model, and keep `loc` for citations.
4. Compare text on a sample of your real (non-personal) files before removing the old packages; that comparison runs in your code base, not in docsluice.
5. Remove `xlsx`, `mammoth`, `adm-zip` and `yauzl`; keep `pdf-parse` until the PDF reader ships.

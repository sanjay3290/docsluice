# Plain-text rendering

`toText(document)` renders block content in order, with a blank line between sibling blocks. Headings, paragraphs, code, notes, headers, footers, and image alt text render as plain text. Lists put one item on each line, using the stored marker or a deterministic default (`•` for unordered lists and `1.`, `2.`, … for ordered lists); each nested level adds two spaces. Tables use tabs between cells and line breaks between rows. A section adds no title or marker; its child blocks render in order.

Extracted child documents are omitted by default. Pass `{ children: true }` to append each extracted child after its path on a separate line. This changes the output positions of later text. `loc.offset` values point into the default `toText(document)` result, so compute offsets again if you render with options that add or change text.

`toText` processes block data under the default renderer limits for output characters (20 million), table cells (2 million), block nesting (64), child-document depth (3), and elapsed time (60 seconds). It throws the corresponding limit error instead of returning partial text. It also rejects active child-document cycles.

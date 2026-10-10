# ODP

The ODP reader (`docsluice/odp`) reads OpenDocument presentations with the same output as [PPTX](pptx.md): one `slide` section per `draw:page`, in document order, with `loc.slide` numbered from 1. `test/readers/odp/parity.test.ts` checks that the LibreOffice PPTX and ODP exports of the same decks give the same blocks.

## Slides

- **Title**: the first shape with `presentation:class="title"` and text, its paragraphs joined by spaces. It becomes the section title and a level-1 heading, and is not repeated as a paragraph.
- **Reading order**: shapes on the page and inside groups (`draw:g`, whose children carry page coordinates) are sorted top to bottom, then left to right, by `svg:y` and `svg:x`, in any ODF length unit. Shapes without a position follow in document order.
- **Text**: `text:p` and `text:h` paragraphs, with `text:s` (spaces, at most 1,024 per element), `text:tab` and `text:line-break`. Annotations are not part of the text.
- **Lists**: paragraphs in `text:list` become list blocks nested by list depth. Markers come from the list style (`styles.xml` and automatic styles): bullet characters (private-use glyphs become `•`), and numbers in `1`, `a`, `A`, `i` or `I` format with `(`/`)`/`.` affixes and `text:start-value`. Numbering continues across lists in one shape until a paragraph with text ends it, as PowerPoint numbering does. Paragraphs outside a `text:list` are plain paragraphs, even in an outline placeholder.
- **Tables**: a `table:table` in a frame becomes a table block. `table:table-header-rows` rows, or the first row when `table:use-first-row-styles="true"`, are header rows. `number-columns-spanned`/`number-rows-spanned` become `colSpan`/`rowSpan`, covered cells are empty cells, and repeats and spans are clamped to 75, as in PowerPoint.
- **Footer**: a `presentation:class="footer"` shape becomes a `footer` block. Date, slide-number and header placeholders are generated text and are left out.
- **Speaker notes**: the notes placeholder and plain text boxes in `presentation:notes` become one `speaker-notes` note per slide. The notes-page slide image and page numbers are left out.
- **Hidden slides**: a page whose drawing-page style has `presentation:visibility="hidden"` is a section with `hidden: true`. One `HIDDEN_CONTENT` warning gives the count, as in PPTX.

Attributes and elements are matched by namespace, not by prefix.

## Package

- `META-INF/manifest.xml` with `manifest:encryption-data` throws `EncryptedError`, as do encrypted ZIP entries.
- `meta.xml` gives the metadata (see [odf.md](odf.md)).
- `Basic/` or `Scripts/` entries set `hasMacros` with a `MACROS_PRESENT` warning. Macros are never run.
- `draw:object`, `draw:object-ole`, `draw:plugin`, `Object …` and `ObjectReplacements/` entries set `hasEmbeddedFiles`. A link with a URI scheme sets `hasExternalLinks`.
- `styles.xml` and `content.xml` are read with the bounded SAX tokenizer, so `xmlDepth`, `cells`, `totalUncompressedBytes` and time limits apply. Groups and lists are tracked with explicit stacks. A missing `content.xml` gives an empty document with an `UNREADABLE_PART` warning, and duplicate part names are not read.

Not supported: images and charts (no image blocks, as in PPTX), master-page content, `presentation:footer-decl` footers, custom shows, transitions, animations and flat `.fodp` files.

## Corpus and generators

`corpus/odp` holds the LibreOffice ODP exports of the four `deck-*` PPTX corpus decks, which come from the same `.fodp` sources. `reading-order.odp` is converted from `corpus/pptx/reading-order.pptx`: LibreOffice drops the outline levels and the SmartArt diagram and reads the `mc:Choice` branch, so its golden differs from the PPTX one there. `scripts/hostile/generate-odp.mjs` writes `hostile/odp`.

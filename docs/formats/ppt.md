# Legacy PowerPoint decks (.ppt)

PowerPoint 97-2003 decks are OLE compound files (see [ole.md](ole.md)) with a `Current User` stream and a `PowerPoint Document` stream. `extract()` loads the reader lazily for `ppt` input; it is also the `docsluice/ppt` subpath (`pptReader`). The output has the same shape as the [PPTX reader](pptx.md): every slide is a `section` with `role: 'slide'`, `loc.slide` (1-based) and, for child documents, `loc.path`.

The implementation follows Microsoft's public [MS-PPT specification](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/6be79dde-33c1-4c1b-8ccc-4b2301c08662).

## Live content

- The `Current User` stream gives the offset of the newest `UserEditAtom`. The reader follows the chain of edits back to the first save and builds the persist object directory from them. An object saved again in a later edit replaces the earlier copy, so text from stale saves never appears.
- Every step of the edit chain must move to an earlier offset. A chain that loops, or that points at the wrong record type, fails with `CORRUPT_FILE`.
- The document container comes from the edit's `docPersistIdRef`. A Current User token for RC4 CryptoAPI encryption, or a `UserEditAtom` with an encryption session reference, fails with `ENCRYPTED`. docsluice does not decrypt PPT files.

## Slides, titles and text (PPT-1, PPT-2)

- Slides come in the order of the slide list (`SlideListWithTextContainer`, instance 0), never in the order of the objects in the stream.
- A slide's text is read in this order:
  1. The text that follows its `SlidePersistAtom` in the slide list (outline placeholders).
  2. The text boxes of its drawing (`OfficeArtClientTextbox`), in shape-tree order. Text boxes that hold an `OutlineTextRefAtom` repeat slide-list text and are skipped.
- The text type comes from the `TextHeaderAtom`, or from the shape's `OEPlaceholderAtom`.
- The first text of type Title or CenterTitle, or in a title placeholder, is the slide title. It becomes the section `title` and a level-1 `heading`, with its paragraphs joined by spaces.
- Date, slide-number, footer, header and slide-image placeholders hold generated text, and are skipped.
- Other text becomes `paragraph` blocks: one per paragraph mark (CR), with vertical tabs as line breaks.
  - `TextCharsAtom` is UTF-16LE.
  - `TextBytesAtom` holds the low bytes of UTF-16 code units.
- Drawing containers nested deeper than `blockDepth` are not entered. This gives one `DEPTH_LIMIT` warning.
- A slide whose object is missing from the persist directory keeps its slide-list text. Such slides, and missing notes, add one `UNREADABLE_PART` warning with their count.

## Speaker notes (PPT-4)

Notes (`SlideListWithTextContainer` instance 2) are matched to slides through the `NotesAtom` slide id. A notes page becomes one `note` block with `role: 'speaker-notes'`, last in its slide's section. Its text comes from:

- the notes body placeholder;
- text of type Notes;
- text boxes that are not placeholders.

Notes for an unknown slide id are dropped.

## Not yet read

- Hidden-slide flags.
- Bullets and list levels: body paragraphs become plain paragraphs.
- Tables.
- Pictures and their alt text.
- Comments.
- Master and layout text.
- Document properties (`SummaryInformation`), as with the other legacy readers.
- LibreOffice-made decks often store titles as plain text boxes after the first slide. Those slides then have no title, as in the PPTX and ODP exports of the same source.

## Corpus and generators

- `corpus/ppt/*.ppt` are LibreOffice exports of `scripts/corpus/src/deck-12-slides.fodp`, `deck-hidden-notes.fodp` and `ppt-order-title-notes.fodp`, made by `scripts/corpus/build.mjs`.
- `corpus/ole/libreoffice.ppt` is a one-slide deck whose title LibreOffice did not export.
- `scripts/hostile/generate-ppt.mjs` writes `hostile/ppt`:
  - a drawing nested 1,000 containers deep (`DEPTH_LIMIT`);
  - a self-referencing edit chain (`CORRUPT_FILE`);
  - an encrypted Current User token (`ENCRYPTED`);
  - 5,000 slides whose objects are missing (one `UNREADABLE_PART`);
  - a text atom of 100,000 paragraph marks.

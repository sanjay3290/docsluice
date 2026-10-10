# PPTX support

The PPTX reader turns every slide of a PresentationML deck (`.pptx`, `.ppsx`, `.potx` and their macro-enabled forms) into a `section` with `role: 'slide'`. `extract()` loads it lazily for `pptx` input; it is also the `docsluice/pptx` subpath (`pptxReader`). Package parts, relationships, document properties and feature flags come from the shared OOXML helpers (see [ooxml.md](ooxml.md)).

## Slides and titles (PPT-1, PPT-2)

- Slide order comes from `presentation.xml` `p:sldIdLst`, resolved through the presentation relationships, never from part names (`slide10.xml` can come first).
- Each section has `loc.slide` (1-based) and `loc.path` (the slide part). A slide part that is missing gives an empty section and `UNREADABLE_PART`.
- The first `title` or `ctrTitle` placeholder with text is the slide title: the section `title` and a level-1 `heading` block. Its paragraphs are joined with spaces. Text boxes that only look like titles are ordinary text.

## Reading order (PPT-3)

- Shapes are read top to bottom, then left to right, by the top-left corner of each shape. Ties keep the order of the shape tree, and shapes without a position come last.
- Placeholders without their own `a:xfrm` take the position of the matching placeholder on the slide layout (same `idx`, else the same type), then on the slide master. Layouts and masters are read once, and only when a slide needs them.
- Group shapes (`p:grpSp`) apply their transform (`a:off`, `a:ext`, `a:chOff`, `a:chExt` scaling) to the shapes inside them, so grouped shapes are placed where they appear on the slide. Groups nested deeper than `blockDepth` keep their parent's transform and add one `DEPTH_LIMIT`; very deep nesting then reaches the XML depth budget, which truncates the slide with `TRUNCATED`.
- `mc:AlternateContent`: `mc:Choice` is skipped and `mc:Fallback` is read.

## Text, lists, tables, SmartArt

- Each `a:p` is one paragraph; `a:br` is a line break; field text (`a:fld`) is kept.
- Bulleted paragraphs become `list` blocks, nested by `a:pPr lvl`. A paragraph is bulleted when it has `a:buChar` or `a:buAutoNum`, or when it sits in a body or content placeholder (`body`, `obj`, or a placeholder with only an `idx`) and has no `a:buNone`. Markers: the bullet character (private-use and Wingdings/Symbol glyphs become `•`, `▪`, `➢`, `✓`, `❑`, `❖`, `■`, `●`), or the auto-number scheme (`arabicPeriod` `1.`, `arabicParenR` `1)`, `arabicParenBoth` `(1)`, `alphaLc…`/`alphaUc…` letters, `romanLc…`/`romanUc…` numerals; others as `1.`). `ordered` is true when the list starts with a numbered paragraph.
- Tables (`a:tbl` in a graphic frame) follow the grid convention: `gridSpan`/`rowSpan` cells get `colSpan`/`rowSpan` (clamped to 75), and `hMerge`/`vMerge` cells are empty placeholders. `headerRows` is 1 when `a:tblPr firstRow` is set. Every cell counts toward `cells`; the table stops at the limit with `TRUNCATED`.
- SmartArt text comes from the diagram data part (`dgm:relIds r:dm`): each node point's text (not presentation, transition or document points) becomes a list item in data order, nested by its `parOf` connections (at most 8 levels; cycles stop there).
- Footer placeholders (`ftr`) become `footer` blocks. Date, slide-number and header placeholders hold generated text and are skipped.

## Not yet read

Speaker notes and hidden-slide flags (pptx2), pictures and their alt text, chart data (PPT-6), and comments.

Hostile samples in `hostile/pptx/`: groups nested 1,000 deep (`DEPTH_LIMIT`, then `TRUNCATED`), a SmartArt part with 10,000 points whose connections form one cycle, and prototype-named relationship ids, placeholder types and slides with a table of huge spans (inert).

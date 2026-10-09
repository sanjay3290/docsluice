# PowerPoint presentations

The `.pptx` reader follows the package `officeDocument` relationship to the presentation part, then reads slides in `p:sldIdLst` order. Each slide becomes a `slide` section; only `title` and `ctrTitle` placeholders set the section title and produce a heading. Text shapes are ordered by transformed vertical position, then horizontal position, then their order in the slide XML. Group transforms and inherited layout/master placeholder positions are applied where present. Body text and explicit DrawingML bullets are represented as lists; DrawingML tables become table blocks, and SmartArt diagram data is emitted as a text list.

Shape traversal is iterative and shares the configured block-depth budget. XML parsing shares the XML-depth and archive budgets, while structural XML text is not charged as emitted `outputChars`; a local cap limits each presentation part to 500,000 retained XML elements and 20 million XML text/source-work units. Table cells consume the shared cell budget, including empty cells. Other local safety caps bound retained shapes, paragraphs, and SmartArt items. Invalid optional slide parts are skipped with a static `UNREADABLE_PART` warning. Hidden slides are always included, marked `hidden: true`, and produce a `HIDDEN_CONTENT` warning. This behavior does not depend on `includeHidden`.

Speaker notes are extracted through the slide's internal notes relationship as
`note` blocks with role `speaker-notes`. Only body-placeholder paragraphs are
retained; image and slide-number placeholders are ignored. Notes carry their
notes-part path and containing slide number. Missing or malformed optional
notes produce one generic `UNREADABLE_PART` warning. Paragraph-boundary
truncation and typed failures use the shared budget.

Chart shapes are read only when a `graphicFrame` directly references an internal chart relationship. Cached bar, line, and pie series become tables in the shape's geometry-sorted reading order; non-contiguous cache indexes produce blank rows. The reader uses cached values only and never evaluates chart formulas or follows external chart relationships. Chart-part XML parsing uses the same structural budget as slide XML, and chart caches have independent object/character caps. Each emitted chart table carries its containing slide number and slide-part path.

This reader does not yet extract images or embedded objects. Shape rotation and
flip metadata are not applied to ordering coordinates. Synthetic CC0 unit
fixtures cover relationship ordering, title placeholders, geometric ordering
and ties, inherited placeholder coordinates, group transforms, tables,
SmartArt, cached charts, and hostile nesting. The LibreOffice corpus
direct-reader comparison includes all three chart tables and both speaker
notes; public detection and corpus-runner integration remain separate work.

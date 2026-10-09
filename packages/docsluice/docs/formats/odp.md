# OpenDocument Presentation (ODP)

The ODP reader reads `content.xml` pages in document order and emits a `slide`
section for each page. It selects the first frame marked
`presentation:class="title"` as the section title, sorts other frames by their
position from top to bottom and then left to right, and adds nested group
offsets before sorting. Frames and custom shapes are visited as positioned
objects. Text paragraphs, headings, lists, tables, images and
speaker notes remain structured blocks. Speaker notes stay at the end of their
slide and never get copied into body text.

ODF image references are matched to exact, literal ZIP part names. The reader
does not URI-decode paths, open external links, or fetch remote images. Listed
image parts appear in `children`; their image blocks point to those children
with `ref`. Alt text comes from `svg:desc` and then `svg:title`; frame width and
height are converted to CSS pixels when the unit is known. With `childBytes: true`,
readable image parts carry their raw bytes on the listed child; otherwise the
reader only lists them and does not read their payloads.

Hidden slides are included in their original position. The reader emits a
`HIDDEN_CONTENT` warning when it sees one. The current `DocBuilder` reader API
has no way to set `SectionBlock.hidden`, so that section flag remains an
integration gap for this reader implementation. `includeHidden` does not omit
ODP slides; the PRD's option applies to hidden Word text, while PPT-5 says to
include hidden slides by default and flag them.

ODP package manifest entries marked encrypted are rejected with
`EncryptedError('password-required')`; the reader does not decrypt content.
Metadata follows the shared ODF metadata helper, including removal of authors
and custom properties when `metadata: false`. Speaker-note author fields are
omitted from note text.

Tests use the CC0 hand-authored structural fixture
`test/odp/fixtures/odp_order_hidden.odp` and small in-memory ZIP packages.
These are parser probes, not LibreOffice-produced
corpus fixtures. No PPTX parity or golden-file acceptance is claimed until the
PPTX reader and reviewed office-suite corpus are available.

List text and nesting are retained, but ordered list numbering/style markers
are not reconstructed yet; list blocks currently use `ordered: false`.

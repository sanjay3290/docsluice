# EPUB

The EPUB reader extracts package metadata and XHTML chapters from EPUB 2 and EPUB 3 ZIP containers. It follows `META-INF/container.xml` to the OPF package, resolves manifest references as local archive paths, and emits each readable chapter as a `section` with role `part` in spine order. NCX labels or EPUB 3 navigation links supply section titles; the chapter XHTML is passed to the shared HTML reader.

The reader skips spine entries marked `linear="no"` by default. The existing `includeHidden: true` option includes these supplementary entries. This is a compatibility choice because the current options contract has no EPUB-specific switch.

OPF `dc:title`, `dc:creator`, `dc:language`, `dc:date`, and `dcterms:modified` values populate the corresponding document metadata fields. Creator names are omitted when `metadata: false`; title, dates, and language remain.

The reader does not fetch remote resources or decrypt content. It rejects encrypted container or OPF control data with `EncryptedError`. Encrypted chapter and navigation parts are skipped, set `features.isEncrypted`, and produce an `UNREADABLE_PART` warning. A declared `META-INF/encryption.xml` also sets `features.isEncrypted`.

OPF and content references reject absolute paths, URI schemes, malformed percent escapes, backslashes, and paths that escape the archive root. XML parsing, ZIP entry counts, decompressed bytes, output, aborts, and elapsed time use the shared parser and budget safeguards.

Current fixtures are authored CC0 EPUB 2 and EPUB 3 containers in [the corpus](../../corpus/epub/). They cover spine order, navigation labels, OPF metadata, non-linear items, and licensed input provenance.

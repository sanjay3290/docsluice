# EPUB

The EPUB reader (`docsluice/epub`, detected from the `application/epub+zip` package `mimetype`) reads EPUB 2 and EPUB 3 books. It follows `META-INF/container.xml` to the OPF package and resolves manifest references as local archive paths. Each readable chapter becomes a `section` with role `part`, in spine order. The chapter XHTML goes through the shared HTML block builder, so headings, paragraphs, lists and tables keep their shapes.

## Chapters and titles

- Spine entries marked `linear="no"` (covers, notes) are skipped by default. `includeHidden: true` includes them, because the options contract has no EPUB-specific switch.
- Section titles come from the EPUB 3 navigation document's `toc` nav (landmarks and page lists are not titles), else from the EPUB 2 NCX. The first entry that points at a file names its chapter; later entries point at fragments inside it.

## Metadata

OPF `dc:title`, `dc:creator`, `dc:language`, `dc:date` and `dcterms:modified` fill the matching metadata fields. Creator names are removed with `metadata: false`; title, dates and language stay.

Dates are read only in the ISO 8601 forms OPF uses (`YYYY`, `YYYY-MM`, `YYYY-MM-DD`, or a date-time with optional seconds, fraction and zone), and they are reported in UTC. A date-time without a zone is read as UTC, never in the host time zone. Other forms and impossible dates such as `2023-02-29` are left out, so the result never depends on the JavaScript engine (DET-1).

## Encryption

The reader never decrypts. Encrypted container or OPF control data throws `EncryptedError`. A book whose linear spine documents are all listed in `META-INF/encryption.xml` (DRM) also throws `EncryptedError`. When only some documents are encrypted, those are skipped with `UNREADABLE_PART` and `features.isEncrypted` is set. Font obfuscation (`http://www.idpf.org/2008/embedding`, `http://ns.adobe.com/pdf/enc#RC`) hides fonts, not content, so it is not reported as encryption.

## Safety

OPF, navigation and content references reject absolute paths, URI schemes, malformed percent escapes, backslashes and paths that escape the archive root. Remote images and links in chapters are never fetched. XML parsing, ZIP entry counts, decompressed bytes, output, aborts and elapsed time all use the shared parser and budget safeguards. `UNREADABLE_PART` is reported once per book, however many parts fail.

## Corpus

- `corpus/epub/gettysburg-address.epub`: EPUB 3 exported by LibreOffice (`scripts/corpus/build.mjs`) from `scripts/corpus/src/gettysburg-address.fodt`, the public-domain Gettysburg Address. LibreOffice's exporter writes headings and list items as paragraphs, and the golden records that faithfully.
- `corpus/epub/gettysburg-address-epub2.epub`: EPUB 2.0.1 (OPF 2.0, NCX, XHTML 1.1) of the same text, built deterministically by `scripts/corpus/make-epub2.mjs`. It has a non-linear cover and an NCX fragment entry.
- `corpus/epub/tiny-epub2.epub` and `tiny-epub3.epub`: small authored CC0 packages.

## Known gaps

Images inside chapters are image blocks with their source path; they are not listed as child documents. Media overlays, fixed-layout rendition properties and scripted content are ignored.

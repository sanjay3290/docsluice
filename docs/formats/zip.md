# ZIP archives

`openZip(bytes, budget)` indexes the ZIP central directory without extracting files. It supports stored (method 0) and DEFLATE (method 8) entries, classic ZIP and ZIP64 end records, UTF-8 names, and legacy CP437 names. Encrypted and unsupported-method entries stay visible with `isUnreadable: true`; `read(entry)` returns `null` for them. Entry order follows the central directory.

Names are display strings only: leading roots and drive prefixes are removed, `..` and `.` components are dropped, backslashes become separators, and control characters become the replacement character. The library never writes archive paths to disk.

Every DEFLATE output chunk is counted against the shared uncompressed-byte budget and checked against the per-entry compression ratio before more compressed input is supplied. Compressed input is fed in slices sized so that the worst-case output of one slice (DEFLATE expands at most about 1032:1) stays within 64 KiB of every bound: the declared size, the compression ratio checked after the slice, and the remaining shared uncompressed-byte budget. Slices start at 63 bytes and grow up to 4 KiB only while those bounds allow, because each slice costs the inflater a 32 KiB window copy; near any bound they shrink back to 63 bytes. The central-directory uncompressed size is a consistency check only; output more than 64 KiB above that claim is cut off and reported as `UNREADABLE_PART`, while a final size or CRC mismatch also makes the entry unreadable. ZIP entries are checked for overlapping local-record ranges before they can be read. Signed and unsigned data descriptors are validated against central-directory values.

Multi-volume archives are unsupported. ZIP64 values above JavaScript's safe integer range are rejected as corrupt rather than rounded.

The reader uses the exact-pinned, pure-JavaScript `fflate` dependency approved in [ADR 0005](../adr/0005-inflate-and-zip.md) and [ADR 0011](../adr/0011-dependency-policy.md). It has no Node imports and does not access the filesystem.

## Container kind detection

The detector opens the archive once and returns that `ZipArchive` for the selected reader to reuse. It reads only `[Content_Types].xml` and, when `mimetype` is the physical first local member and is stored, that entry's payload. This check uses the first local header, not central-directory order. Duplicate `mimetype` entries are ambiguous and are not used. OOXML classification requires a namespace-correct `Override` for the recognized main part and exact main-part content type; content in a filename, `Default` record, unrelated XML part, or arbitrary XML text does not establish a kind. ODT, ODS, ODP and EPUB use their exact `mimetype` values.

Classification markers above 1 MiB are skipped before inflation, reported as `UNREADABLE_PART`, and left as generic ZIP. A marker that exceeds the caller's remaining shared uncompressed-byte budget follows the budget's configured throw or truncate behavior before it is read. If both marker families identify different kinds, the archive is ambiguous and stays generic ZIP. `mimetype` is recognized only when it is the first entry and uses ZIP's stored method.

## ZIP as a document (NST-1 … NST-6)

A plain ZIP archive (one that is not an Office or OpenDocument package) is read by the container reader (`docsluice/zip`, `zipReader`). The archive document has no blocks of its own; each entry becomes a `ChildDocument`, in central-directory order, with the entry name as `name` and the parent path plus the name as `path` (`inner.zip/notes.txt`). That path is the `loc.path` prefix of every block inside the child (NST-3).

- `children: 'extract'` (the default) inflates one entry at a time under the shared budget and reads it as a child document with its own detection, so a child cannot reset byte, entry, time or output limits (NST-1). Nesting deeper than `childDepth` (default 3) is listed, not opened, with `DEPTH_LIMIT` (NST-2). A child byte-identical to one of its ancestors is listed, not opened (NST-6).
- `children: 'list'` lists every entry with `status: 'listed'` and its declared `sizeBytes` and reads no entry data, so a bomb is not inflated. `children: 'skip'` adds no children (NST-4). `childBytes: true` keeps each extracted child's bytes (NST-5).
- Directory entries and operating-system files (`__MACOSX/`, `.DS_Store`, `Thumbs.db`, `desktop.ini`) are listed with `status: 'skipped'`.
- Encrypted entries are `failed` with error code `ENCRYPTED`, and `features.isEncrypted` is set. An entry that cannot be inflated is `failed` with `CORRUPT_FILE`; an entry stopped by the uncompressed-byte budget is `failed` with `LIMIT_EXCEEDED` (and the document is truncated). The compression-ratio limit always throws, so a ratio bomb makes the whole extraction fail with `LIMIT_EXCEEDED`.
- A directory with more entries than `zipEntries` is not indexed at all (SEC-2): the archive has no children and `TRUNCATED`.

Hostile samples in `hostile/zip/` pass through the container reader: ratio bombs and nested bombs, an 8-deep chain of nested archives, a nested archive with 10,001 entries, path-traversal names (kept as display paths), overlapping entries, ZIP64 lies, and OS junk next to an encrypted entry. A true self-reproducing ZIP (a DEFLATE quine) is not in the corpus yet; the ancestor check is tested in the core pipeline tests.

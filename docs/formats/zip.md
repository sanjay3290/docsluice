# ZIP archives

`openZip(bytes, budget)` indexes the ZIP central directory without extracting files. It supports stored (method 0) and DEFLATE (method 8) entries, classic ZIP and ZIP64 end records, UTF-8 names, and legacy CP437 names. Encrypted and unsupported-method entries stay visible with `isUnreadable: true`; `read(entry)` returns `null` for them. Entry order follows the central directory.

Names are display strings only: leading roots and drive prefixes are removed, `..` and `.` components are dropped, backslashes become separators, and control characters become the replacement character. The library never writes archive paths to disk.

Every DEFLATE output chunk is counted against the shared uncompressed-byte budget and checked against the per-entry compression ratio before more compressed input is supplied. Compressed input is fed in 63-byte slices to keep inflater output bursts within the reader's 64 KiB accounting slack while avoiding one-byte-call overhead. The central-directory uncompressed size is a consistency check only; output more than 64 KiB above that claim is cut off and reported as `UNREADABLE_PART`, while a final size or CRC mismatch also makes the entry unreadable. ZIP entries are checked for overlapping local-record ranges before they can be read. Signed and unsigned data descriptors are validated against central-directory values.

Multi-volume archives are unsupported. ZIP64 values above JavaScript's safe integer range are rejected as corrupt rather than rounded.

The reader uses the exact-pinned, pure-JavaScript `fflate` dependency approved in [ADR 0005](../adr/0005-inflate-and-zip.md) and [ADR 0011](../adr/0011-dependency-policy.md). It has no Node imports and does not access the filesystem.

## Container kind detection

The detector opens the archive once and returns that `ZipArchive` for the selected reader to reuse. It reads only `[Content_Types].xml` and, when `mimetype` is the physical first local member and is stored, that entry's payload. This check uses the first local header, not central-directory order. Duplicate `mimetype` entries are ambiguous and are not used. OOXML classification requires a namespace-correct `Override` for the recognized main part and exact main-part content type; content in a filename, `Default` record, unrelated XML part, or arbitrary XML text does not establish a kind. ODT, ODS, ODP and EPUB use their exact `mimetype` values.

Classification markers above 1 MiB are skipped before inflation, reported as `UNREADABLE_PART`, and left as generic ZIP. A marker that exceeds the caller's remaining shared uncompressed-byte budget follows the budget's configured throw or truncate behavior before it is read. If both marker families identify different kinds, the archive is ambiguous and stays generic ZIP. `mimetype` is recognized only when it is the first entry and uses ZIP's stored method.

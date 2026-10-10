# GZIP

The GZIP reader (`docsluice/gzip`, detected from the `1f 8b` signature) gives one child: the decompressed bytes. Concatenated members are joined in order, as RFC 1952 asks. The child is named from the first member's original file name (`FNAME`), else from the input file name without `.gz`, else `content`. Names are plain relative paths: drive letters, `.` and `..` segments and control characters are removed, and nothing is written to disk. The child goes through normal format detection, so a `.tar.gz` gives a TAR child whose entries are its own children.

## Safety

- The header's `FEXTRA`, `FNAME`, `FCOMMENT` and `FHCRC` fields are read with bounds. A bad `FHCRC` or a field that runs past the file is `CORRUPT_FILE`. Original names longer than 4,096 bytes are ignored with a warning.
- fflate inflates the data in 4 KB slices of compressed input. Every output chunk is charged to the shared `totalUncompressedBytes` allowance, and the compression ratio is checked per member as output arrives, so a gzip bomb stops with `LIMIT_EXCEEDED`. Each member counts as an entry.
- Each member's CRC-32 and size trailer is checked. A damaged trailer, a stream cut short, or damage after some data was inflated keeps the inflated bytes, with `UNREADABLE_PART`. Damage before any data is `CORRUPT_FILE`.
- `children: 'list'` lists the would-be child without inflating; `children: 'skip'` does no decompression. The child shares the parent's budget and the child depth limit (NST-1).

GZIP does not record a content type, so the child is passed to detection without a MIME hint.

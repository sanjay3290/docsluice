# TAR

The TAR reader supports ustar headers, checksum validation, PAX `path` and `size` records, and GNU long-name records. Regular-file bodies are passed to child extraction in archive order. Directory entries are skipped; symbolic and hard links are listed as metadata and never followed. Other special entry types are skipped. Names are normalized to plain relative paths, with `.` and `..` segments removed.

Header and PAX-declared sizes are checked against the actual archive bounds before a body is passed to a child. Entry counts and body bytes use the shared budget. PAX records are bounded by the archive/input and output-text limits; the reader does not allocate an array sized from an untrusted size field. `children: 'list'` emits names and sizes without reading regular-file bodies (small extension metadata still must be read to resolve path/size overrides); `children: 'skip'` parses structural headers but does not emit or extract children.

This is text/document extraction, not filesystem unpacking: no links are followed, and file paths are never materialized on disk. `.tar.gz` is a GZIP child containing a TAR document; nested extraction allows the standard GZIP then TAR readers to process it.

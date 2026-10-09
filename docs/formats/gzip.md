# GZIP

The GZIP reader returns one child containing the decompressed bytes. Concatenated members are joined in order, following the GZIP format. `FEXTRA`, `FNAME`, `FCOMMENT`, and `FHCRC` are parsed with bounds; `fflate` performs streaming DEFLATE, and this reader verifies each member's CRC32 and uncompressed-size trailer before emitting the child. The first member's original name is used when present; otherwise the input filename without `.gz`, or `content`, names the child.

Each output chunk is charged to the shared uncompressed-byte budget before it is retained. Compression ratio is checked per member while output arrives. Resource-limit and cancellation errors propagate. Original names longer than 4,096 bytes are scanned safely but ignored with a static warning. `children: 'list'` records the would-be child without inflating; `children: 'skip'` does no decompression.

GZIP metadata does not reveal a reliable content type. The child is passed to normal format detection with an octet-stream hint. No path from the original name is followed or written to disk.

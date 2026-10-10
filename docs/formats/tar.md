# TAR

The TAR reader (`docsluice/tar`, detected from the `ustar` magic) gives one child per entry, in archive order. It reads POSIX ustar headers (with the 155-byte name prefix), pax extended headers (`x` per file, `g` global) for `path` and `size`, and GNU long names (`L`). Header checksums are checked.

- Regular files are extracted as children, each through normal format detection, under the parent's budget (NST-1).
- Directories and special files (devices, FIFOs) are listed as `skipped`. Symbolic and hard links are listed as `listed` metadata and never followed.
- Names are plain relative paths: leading `/`, drive letters, backslashes, `.` and `..` segments and control characters are removed. Nothing is written to disk.

## Safety

- Every header and pax size is checked against the bytes actually present before an entry body is used. No buffer is allocated from a size field.
- Entries count against `zipEntries`, entry bodies against `totalUncompressedBytes`, and pax records are parsed in one bounded pass.
- A header checksum error or size lie before any entry is `CORRUPT_FILE`. The same damage after readable entries keeps those entries, with `UNREADABLE_PART` (partial is better than nothing).
- `children: 'list'` lists names and sizes without reading regular-file bodies. Small extension headers are still read to resolve pax paths and sizes. `children: 'skip'` walks the headers without emitting children.

## Corpus and generators

`scripts/corpus/make-archives.mjs` writes the corpus (`corpus/gzip`, `corpus/tar`), and `scripts/hostile/generate-archives.mjs` writes the hostile files. Both use the deterministic writers in `scripts/corpus/archive-writer.mjs`.

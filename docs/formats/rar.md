# RAR (opt-in plugin)

`docsluice/rar` exports `rarPlugin`, a format plugin that **lists** RAR 4 (1.5-4.x) and RAR 5 archives from their headers ([ADR 0014](../adr/0014-7z-rar-listing-plugins.md)). The default registry does not include it; register it as shown for [7z](7z.md). Without the plugin, a RAR file is detected as `rar` and fails with `UNSUPPORTED_FORMAT`.

## What is read

- **RAR 5.** Blocks follow RARLAB's "RAR 5.0 archive format":
  - Each header CRC32 is checked.
  - File headers give the name (UTF-8), the directory flag and the unpacked size. An unknown size is listed as 0.
  - An encryption record in the extra area sets `features.isEncrypted`.
  - Service headers are skipped.
- **RAR 4.** Blocks follow the RAR 1.5-4.x technical note:
  - File and archive headers have their CRC16 checked.
  - File headers give the name, the directory flag (`0xE0` window bits) and the unpacked size, including the 64-bit high parts.
  - The encrypted flag sets `features.isEncrypted`.
  - Other block types are skipped by their size.
- Entries become children in archive order: files `listed` with `sizeBytes`, directories `skipped`. Names are cleaned as for [7z](7z.md).
- Encrypted headers fail with `ENCRYPTED`: a RAR 5 archive encryption header, or the RAR 4 `MHD_PASSWORD` flag.

## Not read

- **Entry contents.** No RAR decompression is implemented. The algorithms have no public specification, and the UnRAR source licence rules out reusing it.
- **RAR 4 Unicode names.** They store a legacy name, a NUL, then RAR's own compact encoding, which is not in the published notes. The legacy part (Windows-1252) is listed. Non-Unicode RAR 4 names are also decoded as Windows-1252.
- Times, comments, recovery records, multi-volume sets, and self-extracting archives (the signature must be at offset 0).

## Safety

- Every size is checked against the bytes present, and no buffer is allocated from a size field.
- A CRC mismatch or a size past the end after readable entries keeps those entries, with one `UNREADABLE_PART` warning. The same damage before any entry fails with `CORRUPT_FILE`.
- Entries count against `zipEntries`; the listing stops at the limit with `TRUNCATED`.

## Corpus and generators

- `scripts/corpus/make-rar.mjs` writes `corpus/rar` with the deterministic writer in `scripts/corpus/rar-writer.mjs`. The archives use stored entries, and libarchive (`bsdtar -tvf`) lists them the same way.
- `scripts/hostile/generate-listed-archives.mjs` writes `hostile/rar`:
  - a CRC-damaged header and a size lie;
  - encrypted RAR 4 and RAR 5 headers;
  - an overlong vint;
  - 12,000 entries.

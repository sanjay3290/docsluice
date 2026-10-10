# 0014. 7z and RAR: opt-in listing plugins, no decompression

- Status: Accepted
- Date: 2026-10-10
- Requirement IDs: PRD section 8.1 (Archives, P2), EXT-4, SEC-1, SEC-2, SEC-9, design principle "Few dependencies"

## Context

- The PRD lists 7z and RAR as P2 archives. Issue #86 asks whether they belong in the core or in a plugin, and for listing at least.
- **RAR.** RARLAB publishes the header layout of RAR 4 and RAR 5. The compression algorithms are documented only through the UnRAR source, whose licence forbids using it to recreate the RAR compression algorithm. A clean-room decompressor ([ADR 0003](0003-clean-room.md)) has no public specification to work from.
- **7z.** The 7z container and LZMA are described in the public-domain LZMA SDK documents.
  - 7-Zip compresses the archive header itself with LZMA by default. Listing a 7z file therefore needs an LZMA decoder.
  - Extracting contents needs LZMA2, the branch filters (BCJ, BCJ2, ARM …) and AES too.
- Few users need 7z or RAR text extraction. Every built-in reader adds detection paths and attack surface, and needs a size budget.
- The plugin API (EXT-4, `registerFormat`, `createRegistry`) lets a reader ship without the default registry loading it.

## Decision

7z and RAR ship in the `docsluice` package as **opt-in format plugins** at the subpaths `docsluice/7z` (`sevenZipPlugin`) and `docsluice/rar` (`rarPlugin`). The default registry does not register them.

- **Listing only.** Each plugin gives the archive's entries as children: names, sizes, `listed` for files and `skipped` for directories. Encrypted contents set `features.isEncrypted`.
- **No content decompression in either plugin.**
  - The 7z plugin includes a bounded, clean-room LZMA decoder written from the LZMA specification, used for LZMA-encoded headers only. An encrypted 7z header fails with `ENCRYPTED`.
  - RAR headers are read from the published notes. No RAR decompression code is written or used, so the UnRAR licence never applies.
- **Detection.** The core detection recognizes the 7z and RAR signatures (`7z`, `rar` format ids). Without the plugin, such a file fails with `UNSUPPORTED_FORMAT` instead of being read as text.
- **No new dependency.**

## Consequences

- The core bundle does not grow. Each plugin has its own size budget, like the other reader subpaths.
- Users who need archive listings opt in:

  ```js
  registerFormat(sevenZipPlugin);
  // or
  createRegistry().registerFormat(rarPlugin);
  ```
- Children are listed, never extracted. A document inside a 7z or RAR archive is not read.
  - Extracting stored (RAR store method, 7z Copy) and LZMA-coded 7z entries is possible later with the same decoder. It needs its own issue and bomb tests.
  - LZMA2 and the branch filters would grow the plugin and need a size review.
- The hostile manifest gains an optional `plugin` field so the hostile runner can register a plugin for a file.

# Review resolutions and remaining limits

Independent reviews are `pdf/fixture-review.md` and `archive/image-review.md`; they describe the preliminary state before the changes below.

- PDF P1 mapping ambiguity: every proposed entry now supplies the actual output-root-relative `source_file` and repository-relative `proposed_target`. A regression check failed before the fix and passes after it; all source paths exist.
- PDF text-placement gap: Poppler checks now verify first/last-page placement for the two multi-page benign samples. Label values, bookmark destination and column-first reading order remain hand-authored intended source facts; their public extraction semantics are unverified and the fixture README says so.
- Compression identity: every determinism claim means repeated generation in this executor, using Python 3.12.14 and zlib 1.3.2. Bytes across Python/zlib versions are unverified; compare checked-in hashes after regeneration elsewhere.
- TIFF correctness: the unused broken no-GPS generator option was removed; GPS source facts now preserve unsigned DMS rationals and N/W references. TIFF inputs explicitly say they contain metadata structure with no pixel strips.
- Image test gaps: the PNG test now checks the exact decoded scanline. The truncated TIFF test now checks that offset plus declared count exceeds EOF. GIF decoding was independently checked with ImageMagick by the reviewer; it remains outside the standard-library test suite.

All corrected structural suites pass. None of these checks establishes docsluice reader implementation, integration, acceptance, golden output, fuzz coverage, page-tree safety, engine runtime compatibility, CI, or performance. The true ZIP quine fixture is missing. JPEG, TIFF and WebP examples are structural snippets, not complete images.

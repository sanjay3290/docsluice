# Independent review: image detector test and fuzz harness additions

**Review date:** 2026-10-09  
**Scope:** Read-only review of the latest changes in `docsluice-package-e-69`: detector signature tests and the typed `ResolvedOptions` value in `fuzz/images.fuzz.ts`. I also inspected the related image fixture labels, source metadata tests, and fixture preparation checks for the requested correctness and safety points. No source or fixture files were changed.

## Findings

No blocking correctness or security issue found in the reviewed additions.

The new table-driven detector test covers each of the five registered image readers (PNG, GIF, JPEG, TIFF in both byte orders, and WebP). For each, it verifies a recognized fixture scores `1`, empty input scores `0`, and changing the first signature byte makes detection score `0`. The fuzzer now supplies all required `ResolvedOptions` fields and retains a 64 KiB input cap, 1-second budget, and no-op child extraction context.

One small test-coverage limitation: the negative detector case corrupts only byte zero. It does not test every signature byte, or every truncated prefix length. This does not invalidate the positive/empty/damaged-prefix coverage requested, but a later detector hardening test could mutate each magic-byte position and try all incomplete prefixes.

The associated fixture preparation materials are explicit about what they prove. They check PNG chunk CRCs and zlib payload plus GIF framing/trailer, and label these two samples as complete tiny images. TIFF generation/test decoding is endian-aware and checks IFD offsets, dimensions, DateTimeOriginal, Make/Model, orientation, GPS references and rational coordinates. GPS fixtures use unsigned DMS values with `N`/`W` reference tags. JPEG is labeled as SOI+APP1/Exif+SOF0 marker structure without SOS or scan data; WebP samples are labeled as header/chunk snippets without entropy data. The hostile TIFF samples are bounded malformed byte structures; the prep tests inspect the cyclic pointer, huge count, and out-of-range string extent without extracting paths or allocating from file-provided sizes. These are format-structure checks, not claims that docsluice extracts all fields correctly or that the snippets decode as complete images.

## Evidence

- `npm test --workspace packages/docsluice -- test/readers/images/images.test.ts`: **1 test file, 32 tests passed**.
- `npm run typecheck --workspace packages/docsluice`: **passed**.
- In `/workspace/package-e-preparation/images`, `python -m unittest -v test_fixtures.py`: **6 tests passed**, including endianness/metadata, hostile-shape, completeness/snippet labeling, and deterministic regeneration checks.

The focused docsluice suite exercises image reader/parser behavior and detection, but it is not end-to-end golden acceptance. No image extraction accuracy claim should be inferred from this review.

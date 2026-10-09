# Package E reader review

Reviewed the current Package E reader sources and tests on 2026-10-09. Requirements were taken from the available non-frozen `/workspace/package-e-preparation/current-issues.json` snapshots for #39, #69, and the GZIP/TAR archive work. No source files were changed.

## Prioritized findings

### P2 — Bound GZIP optional filename/comment lengths before decoding

`packages/docsluice/src/readers/gzip/index.ts:146-162` scans FNAME and FCOMMENT until a NUL terminator, without a field-size ceiling. FNAME is then decoded to a string at line 153 and copied again while normalizing/splitting in `cleanName` at lines 218-243. This runs before the reader handles `children: "skip"` or `"list"` (lines 22-35), and each later concatenated-member header is also inspected at line 84. The overall input cap is 100 MB, but it does not prevent several large string allocations from a single optional field.

Add a smaller explicit maximum for each optional text field and a bounded display name (use a safe fallback or truncate); reject or safely ignore fields beyond that cap. Add synthetic tests for oversized FNAME and FCOMMENT in extract/list/skip modes and on a later concatenated member. This is a memory-amplification hardening concern, not a reproduced exploit.

## ZIP #39

No current ZIP parsing or child-order blocker found. Directory and ZIP64 bounds are checked before central-directory iteration (`packages/docsluice/src/zip/index.ts:258-323`); the central-directory count is charged before parsing (`:73-76`); local header, payload, and descriptor ranges are checked (`:436-513`); overlapping local ranges become unreadable (`:543-558`). Inflation is chunk-fed, checks actual output against the shared byte and ratio budgets, validates output size and CRC, and only then assembles the result (`:181-241`). The container reader preserves archive order and does not call `archive.read` in list/skip modes (`packages/docsluice/src/readers/zip/index.ts:20-47`); tests assert this at `packages/docsluice/test/readers/zip/container.test.ts:111-127`.

Coverage includes path cleanup, ZIP64, a pre-parse million-entry cap, overlap, encryption, CRC, declared-size lies, compressed bombs, shared nested-byte budgets, list-without-payload-read, depth, abort, and deterministic central-directory order. The targeted ZIP and image test command passed **71 tests** on the current tree:

```text
npx vitest run packages/docsluice/test/readers/images/images.test.ts packages/docsluice/test/readers/zip/container.test.ts packages/docsluice/test/zip/open-zip.test.ts
Test Files  3 passed (3); Tests 71 passed (71)
```

Issue #39's end-to-end runner acceptance remains integration-dependent because #10 public registration/nested extraction is outside this reader review. `container.test.ts:213-238` tests direct byte-identical recursion with a fake archive; `open-zip.test.ts:236-281` exercises a nested 4-GiB expansion through the ZIP archive API. The ZIP agent reports that no true quine ZIP fixture was constructed or verified. Keep these as explicit integration/test follow-ups; do not treat them as a requirement for public registration in this reader patch.

## Images #69

The prior-IFD dimension overwrite regression is fixed in the current tree: `packages/docsluice/src/readers/images/exif.ts:200-207` only assigns width/height for the first IFD. The regression test at `packages/docsluice/test/readers/images/images.test.ts:230-252` now passes in the 71-test run above.

TIFF traversal is iterative with visited-offset detection and a 16-directory cap (`exif.ts:171-189`); entry bytes, external values, text, numeric arrays, and GPS rationals have explicit bounds (`:29-37`, `:48-99`). JPEG marker and WebP chunk scans tick the budget and validate ranges (`readers/images/index.ts:73-117`, `:140-209`). GPS output is absent by default and appears only with `imageGps: true` (`images.test.ts:140-148`). With `metadata: false`, emitted metadata is `{}` while dimensions remain on the image block (`:165-175`); the readers disable EXIF parsing for JPEG/TIFF/WebP in that mode (`readers/images/index.ts:255-270`). Dates are validated rather than normalized (`images.test.ts:128-138`). No current GPS or `metadata:false` leak was found.

The image tests use synthetic CC0 fixtures and include IFD loops, huge counts, truncated offsets, bad rationals, malformed markers/chunks, typed-array offsets, and an abort check. The format docs disclose that several fixtures are structural parser inputs rather than complete decodable images. This is consistent with #69's metadata-parser acceptance; it does not establish general image-decoding compatibility.

## GZIP/TAR review

The current targeted suites pass **24 tests**:

```text
npx vitest run packages/docsluice/test/readers/gzip/gzip.test.ts packages/docsluice/test/readers/tar/tar.test.ts
Test Files  2 passed (2); Tests 24 passed (24)
```

For TAR, headers and entry sizes are range-checked before slicing (`packages/docsluice/src/readers/tar/index.ts:25-49`, `:73-84`); PAX/GNU metadata is bounded by the available entry and output/input budgets (`:51-70`, `:167-205`); names are normalized and links are listed rather than followed (`:73-99`, `:254-286`). Tests cover checksums, size lies, PAX/GNU names, base-256 sizes, listing, child-depth limits, output truncation, and malformed headers. I found no additional current TAR security blocker in this pass.

This is a source/test review only. It does not claim frozen-baseline comparison, full `extract()` integration, or complete end-to-end acceptance for the new readers.

## Final archive review resolution (2026-10-09)

Re-read the latest GZIP/TAR source after the archive fixes and reran all focused image, ZIP, GZIP, and TAR suites. The earlier GZIP memory-amplification finding is resolved: FNAME bytes are scanned with budget ticks, but decoded only when at most 4,096 bytes (`packages/docsluice/src/readers/gzip/index.ts:11, 147-162`); the normalized emitted name is therefore bounded. FCOMMENT remains a scan-only field with a budget tick per byte (`:164-171`), with no large string allocation. The oversized-FNAME test proves fallback naming and warning (`packages/docsluice/test/readers/gzip/gzip.test.ts:112-125`).

GZIP member validation remains intact: output callbacks count actual uncompressed bytes, update CRC and check ratio (`gzip/index.ts:59-78`); each concatenated-member boundary validates the prior trailer and exact member ratio before checking the next header (`:80-95`); final completion validates the last trailer and ratio (`:110-114`). The tests cover concatenated members, invalid later headers, compression-ratio and byte limits, cancellation, CRC/trailer corruption, and FHCRC (`gzip.test.ts:100-125, 127-135, 155-194`). No remaining GZIP security blocker found. A direct oversized-FCOMMENT regression would improve symmetry, but the current scanner is tick-bounded and allocation-free.

TAR distinguishes extension payload size from the PAX size override: PAX/GNU extension records use their own header size (`tar/index.ts:43-70`), while the pending override applies to the following entry and is checked before slicing (`:73-84`). PAX extension staging is bounded against input/output limits and shared uncompressed bytes (`:51-55`); decimal parsing ticks every digit (`:248-259`); regular payload extraction charges the shared byte budget and stops after output truncation (`:99-115, 306-313`). Checksums, size lies, extension records, paths, and non-followed links have focused coverage. No remaining TAR security blocker found.

Final focused run:

```text
npx vitest run packages/docsluice/test/readers/images/images.test.ts packages/docsluice/test/readers/zip/container.test.ts packages/docsluice/test/zip/open-zip.test.ts packages/docsluice/test/readers/gzip/gzip.test.ts packages/docsluice/test/readers/tar/tar.test.ts
Test Files  5 passed (5); Tests 96 passed (96)
```

Review disposition: **approve the current reader source for package-level review, with no outstanding security blocker identified in this pass.** This disposition is not end-to-end integration acceptance: public registration, shared-option integration, and true ZIP-quine runner coverage remain outside this review.

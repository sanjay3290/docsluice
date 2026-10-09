# Independent fixture review

**Review date:** 2026-10-09
**Scope:** Read-only review of PDF and archive generators, tests, README, generated manifests, and current fixture outputs. No repository files were changed. I ran both fixture test suites locally; this is still preliminary preparation, not docsluice reader validation.

## Prioritized findings

### P1 — PDF manifest paths do not match generated hostile-file locations

`pdf-fixtures/generate.py` writes hostile cases to `hostile/corrupt-xref.pdf`, `hostile/truncated.pdf`, and `hostile/actions.pdf` under the selected output directory (lines 109–111), while `generated/manifest.delta.json` proposes `pdf/corrupt-xref.pdf`, `pdf/truncated.pdf`, and `pdf/actions.pdf`. There is no `pdf/` subdirectory in the generated output. Those entries may be intended as future corpus-root-relative destinations, but the mapping is undocumented and cannot be applied directly to this output tree. Before consuming the delta, name the destination root explicitly or make the delta paths relative to its fixture root and verify every path exists.

### P2 — PDF structural checks do not verify several semantics named in the expected records

`expected-fixture-content.json` includes page labels and a `readingOrder` sequence (generator lines 61–67), but the test only checks a document-wide form-feed count and that each expected phrase appears somewhere in Poppler output (test lines 38–44). It does not establish phrase-to-page placement, page-label values, outline target/title, URI annotation target, or the two-column reading order. The final marker checks only establish that some PDF tokens exist (lines 46–49). Keep those fields explicitly labeled as intended fixture semantics until an independent semantic check asserts them; add per-page text extraction and a tool/API check for labels, outline, and links before presenting these files as verified coverage. Similarly, the image fixture's `imageCoverage: 1` is a full-page transform of a 1×1 image, not scan-image OCR ground truth; its current `purpose` note correctly says that.

### P2 — “Byte deterministic” archive test proves same-runtime repeatability, not cross-runtime identity

`gzip_bytes()` normalizes the gzip OS byte after `gzip.compress(mtime=0)` (archive generator lines 86–90), and the test compares two runs made with the same `sys.executable` and zlib environment (archive test lines 49–56). Deflate output may vary across Python/zlib versions even with a fixed timestamp and OS byte. Thus the checked claim is repeatability in the test environment, not cross-platform or cross-version byte identity. Either qualify that claim or pin/report Python and zlib versions (or use fixed pre-generated compressed bytes if cross-environment hashes are required).

## Coverage and safety observations

- Both test suites pass here: PDF `python -m unittest -v test_fixtures.py` (1 test); archive `python -m unittest -v test_fixtures.py` (6 tests). Poppler independently reads the four non-hostile PDF fixtures. I also inspected the two-column output and confirmed it contains the expected words; that output preserves same-line left/right placement, so it does not establish the stored column-first `readingOrder` expectation.
- The archive fixtures are bounded by construction: 10,000 empty ZIP entries, about 512 KiB expanded nested ZIP/GZIP payloads, a 65,536-character PAX path, and one-megabyte declared TAR sizes with tiny actual bodies. The archive generator applies a 15 MiB output-file cap and the test only decompresses the fixed 512 KiB payload. It does not extract members to the filesystem. I found no unbounded allocation or path-following operation in the archive generator/tests.
- Archive honesty is good: `fixtures.json`, `manifest.delta.json`, and README clearly mark extraction/reader acceptance and golden output as unverified; they explicitly call the amplification fixtures bounded and the quine absent. The TAR size-lie cases are structurally malformed as described and have a valid header checksum; tests inspect their bytes without asking Python `tarfile` to extract the claimed payload. The symlink in the valid TAR points within its `folder/` subtree and is only listed/read as archive metadata.
- The PDF proposal also calls its delta `PROPOSED_NOT_EXTRACTION_VERIFIED`, notes the action checks required, and marks damaged-file outcomes tentative. Tests do not parse hostile files with Poppler or any docsluice reader; they check only action markers, a changed xref sample, and Poppler parsing for benign PDFs. Treat hostile behavior as entirely unverified.
- Fixture sizes and loops are fixed constants, and generated PDF/TAR/ZIP bytes are written as binary data. No issue appears to create unsafe/unbounded extraction or execute fixture content. The archive cap is checked after fixture bytes are assembled, but all current payloads and dimensions are hard-coded and bounded; this is not a user-controlled allocation path.

## Integration note

The archive delta uses fixture basenames while its generated files live under `archive/fixtures/`; its README correctly says the delta is proposal-only and not directly mergeable. Keep the same root/path mapping explicit for the PDF delta. Neither delta should be registered until the reader-specific expected outcomes and actual extraction paths are validated.

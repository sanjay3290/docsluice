Adds private GZIP and TAR readers under the shared budget. GZIP streams counted DEFLATE output, validates each member’s CRC32/ISIZE and optional header checksum, and concatenates members into one child. TAR bounds checksummed ustar/PAX/GNU entries and lists links without following them.

Closes #61

This is a draft integration handoff. The issue remains incomplete end to end until public extraction and the unchecked criteria pass. Base: fix/verified-foundation at 10ae4985a425842f965bccbb9c86a7e6018c5412.

- [ ] Golden tests: .gz of a CSV, .tar with nested folders, .tar.gz.
- [ ] Hostile: gzip bomb, tar size lies, pax header bombs.
- [ ] `npm run verify` passes and CI is green

## Tests required

- [x] Unit tests
- [ ] Golden tests (corpus files + reviewed expected output)
- [ ] Hostile files added to `hostile/manifest.json`
- [x] Fuzz target in `packages/docsluice/fuzz/` (Runner registration pending.)

## Validation

25 focused tests pass. GZIP/TAR line coverage is 92.99%/93.48%. Full npm run verify passes locally (351 tests, lint/types/build/package checks/dist smoke); a writable npm cache is required in this executor. Independent reader review found no remaining blocker. Hosted CI reached terminal failure in the downloaded-dist smoke jobs.

## Decisions

Check CRC32, ISIZE and FHCRC in the reader because fflate does not validate all GZIP checksums. Bound displayed original filenames to 4,096 bytes; oversized names are ignored with a static warning. Check actual per-member output and exact member ratios. TAR’s extension headers use their own raw sizes; PAX overrides apply to following regular entries. No new dependency or shared core change.

## Next integration step

Lead #10: register gzip/tar readers, ensure decompressed children use ordinary format sniffing for .tar.gz, run public CSV/nested-folder/tar.gz goldens, assign hostile-manifest outcomes, and register the fuzz entry points. The fixtures and proposed hostile mapping are in the package E Library checkpoint. Legacy V7 TAR is not confidently detected.

## Hosted CI blocker

The Node 24 verify job passed all source/package checks. Node 20/22/24 downloaded-dist smoke jobs failed because the foundation workflow does not install the declared external runtime dependency fflate. Isolated reproduction gives three failures without fflate and three passes with fflate 0.8.2. Shared workflow correction and rerun belong to the integration lead/A; no shared CI files changed in this PR.

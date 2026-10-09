Adds private PNG/JPEG/GIF/TIFF/WebP readers for dimensions and EXIF metadata. GPS is off by default; metadata:false suppresses EXIF. Iterative TIFF traversal bounds offsets and detects cycles, while preserving IFD0 dimensions.

Closes #69

This is a draft integration handoff. The issue remains incomplete end to end until the unchecked acceptance items and lead-owned integration below pass. Base: fix/verified-foundation at 10ae4985a425842f965bccbb9c86a7e6018c5412.

- [x] Tests with sample images made by a script (no third-party photos).
- [x] Hostile: IFD loops, huge counts. (Direct-reader regression tests; shared hostile runner remains pending.)
- [ ] `npm run verify` passes and CI is green

## Tests required

- [x] Unit tests
- [ ] Hostile files added to `hostile/manifest.json`
- [x] Fuzz target in `packages/docsluice/fuzz/` (Runner registration pending.)

## Validation

32 image tests pass; 93.18% image-reader line coverage. The complete working package passes npm run verify with a writable npm cache. Independent reader review found no remaining blocker.

Hosted CI reached terminal failure in the downloaded-dist smoke jobs; package verification covers source tests and the existing exported foundation bundle, since these readers are not registered yet.

## Decisions

Use metadata.custom pairs for width/height and EXIF fields; created is a timezone-free ISO local capture timestamp. Keep imageGps as a local contract proposal until lead-owned options resolve it. Fixtures are original CC0 samples; TIFF/JPEG/WebP samples are labeled metadata snippets.

## Next integration step

Lead: add imageGps?:boolean (default false) to shared options, register five readers, allow registered no-text readers through dispatch, assign hostile outcomes and register fuzz target. Pipeline a3b45f1 currently skips these readers. Reproducible regressions/proposed dispatch patch are on handoff/package-e-pipeline-regressions at 48a8658fc6706a089ca46dc23eb686b22f834fdd. The 18 image pipeline tests have 9 failures unpatched and all pass with only the proposed temporary dispatch patch, which was restored. Public registration and final shared-core integration remain unverified.

## Hosted CI blocker

The Node 24 verify job passed all source/package checks. Node 20/22/24 downloaded-dist smoke jobs failed because the foundation workflow does not install the declared external runtime dependency fflate. Isolated reproduction gives three failures without fflate and three passes with fflate 0.8.2. Shared workflow correction and rerun belong to the integration lead/A; no shared CI files changed in this PR.

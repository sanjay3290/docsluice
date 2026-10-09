Adds a private ZIP container reader that delegates readable entries in central-directory order under the shared budget. Directory and OS-junk entries are recorded as skipped; encrypted entries fail with ENCRYPTED. List mode reads no payload.

Closes #39

This is a draft integration handoff. The issue remains incomplete end to end until the unchecked acceptance items and lead-owned integration below pass. Base: fix/verified-foundation at 10ae4985a425842f965bccbb9c86a7e6018c5412.

- [ ] Golden test: a zip holding a CSV, an HTML file, a nested zip, and a PNG.
- [ ] Hostile: nested bombs, quine zip, 10,000 entries, path traversal names — all pass through the runner.
- [x] `children: "list"` reads no entry data.
- [ ] `npm run verify` passes and CI is green

## Tests required

- [x] Unit tests
- [ ] Golden tests (corpus files + reviewed expected output)
- [ ] Hostile files added to `hostile/manifest.json`

## Validation

15 ZIP tests pass; 100% ZIP-reader line coverage. The complete working package passes npm run verify with a writable npm cache. Independent reader review found no remaining blocker.

Hosted CI reached terminal failure in the downloaded-dist smoke jobs; package verification covers source tests and the existing exported foundation bundle, since these readers are not registered yet.

## Decisions

Reuse the verified safe ZIP foundation; defer registry/exports/manifest integration to the lead. A fake byte-identical child verifies the local recursion guard; a genuine quine fixture remains outstanding.

## Next integration step

Lead #10: register zipReader, provide nested extractChild behavior, run public mixed-ZIP goldens and hostile runner, register the fuzz target. No shared core or lockfile changes included.

## Hosted CI blocker

The Node 24 verify job passed all source/package checks. Node 20/22/24 downloaded-dist smoke jobs failed because the foundation workflow does not install the declared external runtime dependency fflate. Isolated reproduction gives three failures without fflate and three passes with fflate 0.8.2. Shared workflow correction and rerun belong to the integration lead/A; no shared CI files changed in this PR.

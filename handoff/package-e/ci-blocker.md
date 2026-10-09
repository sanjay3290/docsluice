# Shared CI dependency-install blocker

All three package E PRs reached terminal CI failure. Their Node 24 verify jobs passed lint, types, unit tests, build and package checks; only the downloaded-dist smoke jobs failed on Node 20/22/24.

Evidence: `ci-39-node24.log`, `ci-69-node24.log`, `ci-61-node24.log` report missing declared dependency `fflate` during ESM/CJS/node imports. The foundation workflow downloads the dist artifact and runs the smoke suite without installing dependencies. The compiled foundation chunk imports external `fflate`; package E readers are not publicly registered, and this import precedes these changes.

`ci-dist-dependency-reproduction.log` reproduces the same three failures with isolated compiled dist and no node_modules, then the same three tests pass when the declared fflate 0.8.2 is present. No repository source or CI files were changed by package E.

`ci-fix-proposal.patch` is a concrete minimal proposal for the lead/A: install production dependencies with scripts disabled before the dist smoke command. The integration lead owns CI and must apply/review it, then rerun the affected PR workflows. An alternative packaging policy of bundling dependencies belongs to the lead; no dependency or build-interface change is proposed here. No CI-green claim is made.

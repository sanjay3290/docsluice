# 0014. Documentation site

- Status: Proposed for owner integration
- Date: 2026-10-09
- Requirement IDs: section 20, QA-5

## Decision

Use VitePress 1.6.4 for a small static site rooted at `docs/site`, configured from `docs/.vitepress`. Generate the API HTML with TypeDoc 0.28.20 from `packages/docsluice/src/index.ts`. Build-time tools are isolated in CI rather than added to shared root package metadata while the root owner controls dependency and script integration. The isolated installer pins direct tool versions but does not lock their transitive dependency graph; owner integration should add them to the root lockfile.

The default-limits page is generated from `DEFAULT_LIMITS` in the built public package and checked for drift. Format documentation describes only registered reader behavior and links to the support matrix once issue #65 is integrated. The current CLI integration remains pending issue #63.

## Consequences

- CI can build and validate the static artifact without deployment credentials or repository publishing permissions.
- GitHub Pages deployment is not enabled here. Before publishing, the owner must select the repository base URL and explicitly add a deployment workflow with its permissions.
- The repository owner must add exact site-tool install/build/test scripts and CI integration to the root package metadata after reviewing the tool versions and this isolated implementation.

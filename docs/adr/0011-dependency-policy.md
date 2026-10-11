# 0011. Runtime dependency allow-list

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: SEC-14, design principle "Few dependencies"

## Decision

Runtime dependencies of `docsluice` are limited to this list:

| Package | Pinned | Why | ADR |
|---------|--------|-----|-----|
| `fflate` | 0.8.2 | Pure-JS inflate with byte counting | 0005 |

- Any other runtime dependency needs a new ADR with a written reason, its size, its licence, its maintainer health and its install scripts (none allowed).
- Dev dependencies are free to add, but no package with an install script.
- Pin exact versions for runtime dependencies. Dependabot proposes updates; a human reviews them.

## Vendored build-time dependencies

| Package | Pinned | Why | ADR |
|---------|--------|-----|-----|
| `unpdf` | 1.8.1 | Patched pdf.js, bundled in the lazy PDF chunk | 0009 |

`unpdf` is an exact devDependency. It adds no runtime dependency.
The build must find each approved patch site exactly once (#206, #261, #262).
The package includes both license texts in `dist/THIRD_PARTY_NOTICES.md`.

## Consequences

- CI checks `packages/docsluice/package.json` dependencies against this list (issue: "CI: dependency allow-list check").

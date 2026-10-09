# 0011. Runtime dependency allow-list

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: SEC-14, design principle "Few dependencies"

## Decision

Runtime dependencies of `docsluice` are limited to this list:

| Package | Why | ADR |
|---------|-----|-----|
| `fflate` | Pure-JS inflate with byte counting | 0005 |
| `unpdf` | PDF text layer | 0009 |

- Any other runtime dependency needs a new ADR with a written reason, its size, its licence, its maintainer health and its install scripts (none allowed).
- Dev dependencies are free to add, but no package with an install script.
- Pin exact versions for runtime dependencies. Dependabot proposes updates; a human reviews them.

## Consequences

- CI checks `packages/docsluice/package.json` dependencies against this list (issue: "CI: dependency allow-list check").

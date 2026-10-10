# 0013. Documentation site

- Status: Accepted
- Date: 2026-10-10
- Requirement IDs: PRD section 20 (docs site), section 15 (redaction example)

## Context

The docs site needs a quick start, one page per format, the security model, the limits table, an API reference and runnable recipes. The issue suggested VitePress or Starlight. Both build through Vite or Astro, which install esbuild. esbuild has a `postinstall` script, and Starlight's image pipeline adds sharp, which has one too. ADR 0011 allows dev dependencies freely, but not packages with install scripts. The docs are Markdown files under `docs/` that GitHub already renders; the site only needs to turn them into linked HTML pages.

## Decision

The site is built by `scripts/docs-site.mjs`, a small generator on `markdown-it` that has no install scripts:

- It renders `docs/site/*.md` (home page, quick start, security, recipes) and the existing reference pages (`docs/formats/*.md`, `docs/rendering.md`, `docs/plugins.md`, `docs/node.md`, `docs/worker.md`, `docs/cli.md`).
- It generates the limits page from the built `DEFAULT_LIMITS`.
- It inserts each recipe's code from `examples/`.
- It writes plain HTML with one stylesheet to `site/`.

The API reference comes from TSDoc through TypeDoc (`site/api/`). `npm run docs:site` builds both, and `npm run verify` runs it, so the site builds in CI. Recipes are runnable files in `examples/` with `node --test` tests that import the built package. Publishing to GitHub Pages waits until the repository is public. Publishing is a release decision for the owner, and it is not part of the build.

## Consequences

- No new install scripts, and no framework to keep current. Search, theming and versioned docs are not available; add them with a new ADR if they are needed.
- Docs stay readable on GitHub as plain Markdown. Relative `.md` links become `.html` links on the site.
- A recipe cannot drift from the code, because its page shows the tested file.

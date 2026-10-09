# 0004. One package with lazy subpath exports

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: RT-4, RT-5, PRD Q4, section 18, section 20, SEC-13

## Context

One package is simpler for users. Many packages keep install size down. Bundlers can drop unused code from one package if each format is its own subpath and readers load lazily.

## Decision

- **`docsluice`** (packages/docsluice) holds the core, every built-in reader, the renderers, the chunker, the Node helpers, the worker helper and the CLI.
  - Subpaths: `docsluice` (core + lazy registry of all readers), `docsluice/<format>` (one reader, for example `docsluice/pdf`, `docsluice/xlsx`), `docsluice/node`, `docsluice/worker`.
  - Default `extract()` loads a reader with dynamic `import()` only when a file of that format arrives.
  - CLI: the `bin` entry `docsluice` ships in this package, so `npx docsluice file.pdf` works. CLI code lives in `src/node/cli` and is Node-only.
- **`@docsluice/ocr-tesseract`** (packages/ocr-tesseract) is a separate package, because tesseract.js is large.

## Consequences

- `src/node/` (with `src/node/cli/` and `src/node/worker/`) is the only folder that may use Node APIs. ESLint and a separate tsconfig with Node types enforce this; the rest of `src` compiles with no Node types.
- Bundle budgets (RT-5) are checked per subpath.

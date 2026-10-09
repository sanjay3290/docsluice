# Testing reader bundles

The `reader-bundles` workflow checks the ESM package artifacts after `npm run build`.
It uses the Rolldown version already supplied by tsdown; no extra bundler or package
dependency is installed.

The gate bundles the built public ESM entry and inspects Rolldown's output graph. It
requires the `docsluice` public entry chunk to exist, requires each declared Office
reader export to appear in a chunk reached through a dynamic import, and rejects a
reader export entry found in the public entry chunk or any chunk statically imported
by it. This graph check uses emitted chunk module IDs and import edges rather than
looking for import text in generated JavaScript.

Each declared Office reader ESM entry is also bundled by itself. The gate gzips every
emitted JavaScript chunk and adds those compressed byte counts; each reader must stay
at or below 40 KB (40,000 bytes), matching the repository's `size-limit` decimal-KB
convention. A missing expected export, an export without a
budget registration, a missing built entry, a missing reader module, or a failed lazy
graph is an error. PDF is deliberately outside this budget.

The accepted base currently exports only `docsluice/doc` as an Office reader
subpath. The gate registers DOC's 40 KB budget and validates that it remains both
present and lazy. DOCX, XLSX, and PPTX exports are not present on this base, so they
are not assigned invented budgets here. When an Office reader export is added, add
its subpath to `OFFICE_READER_BUDGETS` in `scripts/check-reader-bundles.mjs` and keep
the integration test's expected export set current. The gate intentionally errors
if a package export exists without that registration.

The package's existing `size-limit` check is run by `npm run check:package`; this
issue does not edit package metadata or that hook. The exact package-owned
`size-limit` entry to add when DOC is registered there is:

```json
{
  "path": "dist/doc.js",
  "limit": "40 KB",
  "gzip": true
}
```

The parent package maintainer should apply that entry in
`packages/docsluice/package.json`'s existing `size-limit` array alongside the other
package checks, then add one matching entry per later Office reader export. The
workflow's Rolldown graph check remains necessary because a size threshold alone
cannot demonstrate lazy loading.

Run the focused gate locally after building with:

```sh
npm run build
node --test scripts/test/reader-bundles.test.mjs
node scripts/check-reader-bundles.mjs
```

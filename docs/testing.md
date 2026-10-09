# Testing

Four kinds of test. Each issue says which kinds it needs. A reader needs all four.

## 1. Unit tests

- Location: `packages/docsluice/test/<module>/<name>.test.ts`, for example `test/zip/open-zip.test.ts`.
- Runner: Vitest. `npm test`.
- Build small inputs in the test itself where you can (a tiny CSV string, a zip made in memory with a test helper).
- Test helpers live in `packages/docsluice/test/helpers/`. A zip writer for tests is fine there; it never ships.

## 2. Golden tests (QA-2)

Real files in, reviewed output out.

```
corpus/
  <format>/
    <name>.<ext>                 # the input file
    <name>.<ext>.license         # SPDX id + source + how it was made (QA-1)
    <name>.<ext>.expected.json   # toJSON(extract(file))
    <name>.<ext>.expected.md     # toMarkdown(extract(file))
```

- The golden runner (`test/golden.test.ts`) walks `corpus/`, extracts each file and compares both outputs byte for byte.
- `UPDATE_GOLDEN=1 npm test` rewrites the expected files. Read every diff before you commit it. A golden change in a PR must be explained in the PR body.
- `.license` file format:

  ```
  SPDX-License-Identifier: CC0-1.0
  Source: made for docsluice with LibreOffice 25.8 from scripts/corpus/src/headings.fodt
  Notes: tests DOC-2 (headings from outline levels)
  ```

- **Licences (risk R4).** Only add files you made yourself, or files with a clear open licence recorded in `.license`. Prefer files made with real office suites by the scripts in `scripts/corpus/` (LibreOffice headless). Never add files from any organisation's systems or private documents.
- Durations are removed from golden JSON (`stats.durationMs` is set to 0 by the runner).

## 3. Hostile tests (QA-3, section 14.3)

Attack files that every reader must survive.

```
hostile/
  manifest.json                  # one entry per file: expected outcome
  zip/      bomb-42k.zip, many-entries.zip, path-traversal.zip, quine.zip ...
  xml/      xxe-file.xml, xxe-url.xml, billion-laughs.xml, deep-10000.xml ...
  proto/    __proto__ keys in every format
  pdf/      loop-xref.pdf, js-action.pdf, launch-action.pdf ...
  ...
```

`manifest.json` entry:

```json
{ "file": "zip/bomb-42k.zip", "expect": { "error": "LIMIT_EXCEEDED" }, "maxMs": 2000, "maxHeapMB": 256, "requirement": "SEC-1" }
```

`expect` is either `{ "error": "<code>" }` or `{ "warnings": ["<code>", ...] }`. An optional `"format"` forces that reader, for attack files that detection would otherwise route to a different format. The runner (`test/hostile.test.ts`) also checks: finished within `maxMs`, no global prototype changed (`Object.prototype` has no new keys), no network call, no unhandled rejection.

Hostile files are made by scripts in `scripts/hostile/` where possible, so the repo holds the recipe, not only the bytes.

## 4. Fuzzing (QA-6)

- Each reader and each parser (`zip`, `xml`, `ole`, `detect`) has a fuzz target in `packages/docsluice/fuzz/<name>.fuzz.ts`.
- Short run on every PR, long run nightly. A crash, hang or limit breach fails the job.
- Every crash becomes a file in `hostile/` and an entry in `manifest.json`.

## Coverage targets (QA-5)

| Module | Line coverage |
|--------|---------------|
| `core/budget.ts`, `zip/`, `xml/` | 100% |
| `readers/*` | 90% |
| everything else | 85% |

## Cross-runtime (QA-4)

CI runs the tests on Node 24 (Vitest), and runs the built package on Node 20, 22 and 24, Bun, Deno, a headless browser and a Workers simulator. A feature that cannot work in one runtime must say so in its docs page and skip that runtime's test with a reason.

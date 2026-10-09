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

- The golden runner (`packages/docsluice/test/golden.test.ts`, part of `npm test`) walks `corpus/`, extracts each file with its name as the `filename` hint, and compares `toJSON(doc, { stable: true })` and `toMarkdown(doc)` byte for byte with the expected files (no trailing newline). A mismatch fails with a diff.
- A file whose expected outputs are missing fails with instructions; CI never creates them. A corpus file for a format that has no reader yet must still fail with `UNSUPPORTED_FORMAT` and must have no expected files. Adding the reader therefore fails the run until its goldens are reviewed and committed.
- Every input needs a `.license` with an `SPDX-License-Identifier:` line, or the run fails. Other sidecars that the runner ignores: `.blocks.json` and `.native.txt` (reader-specific fixtures).
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

`expect` is either `{ "error": "<code>" }` or `{ "warnings": ["<code>", ...] }`. An optional `"format"` forces that reader, for attack files that detection would otherwise route to a different format. The runner (`packages/docsluice/test/hostile.test.ts`) also checks: finished within `maxMs`, no global prototype changed (`Object.prototype` and `Array.prototype` have no new keys), no network call (`fetch` is stubbed to throw), no unhandled rejection (Vitest fails the run on one), and every file in `hostile/` has exactly one entry. `maxHeapMB` is recorded for an isolated runner; in-process Vitest cannot measure heap per file.

Hostile files are made by scripts in `scripts/hostile/` where possible, so the repo holds the recipe, not only the bytes.

## 4. Fuzzing (QA-6)

- Each reader and each parser has a target in `packages/docsluice/fuzz/<name>.fuzz.ts`, registered in the `TARGETS` table of `scripts/fuzz-run.mjs`: parsers `zip`, `xml`, `ole`, `detect`, `detection`, and readers `txt`, `markdown`, `csv`, `json`, `xml-reader`, `html`, `doc`. Run one locally with `npm run fuzz -- <target> [--seconds N]`.
- Jazzer.js runs each target for 60 seconds on pull requests and 30 minutes nightly. The runner caps each input at one second and monitors the child process tree for a 1 GiB memory limit. Unexpected exceptions, hangs, memory-limit breaches, and built-in prototype changes fail the job.
- Preserve every confirmed crash in `hostile/` with an expected result in `hostile/manifest.json`. See [testing-fuzz.md](testing-fuzz.md) for local commands, target wiring, artifacts, and crash triage.

## Coverage targets (QA-5)

| Module | Line coverage |
|--------|---------------|
| `core/budget.ts`, `zip/`, `xml/` | 100% |
| `readers/*` | 90% |
| everything else | 85% |

## Cross-runtime (QA-4)

CI runs unit tests on Node 24 and reuses that build artifact in Node 20/22/24, Bun and Deno jobs. The portable contract exercises a real ZIP and hostile XML. Artifact consumers install production dependencies before running the built package. See [testing-runtime.md](testing-runtime.md) for local commands.

CSV/HTML extraction cases require the extraction pipeline and readers. Browser, Workers and the deliberate `Buffer` acceptance probe remain pending; this contract is partial QA-4 coverage. A feature that cannot work in one runtime must document the reason before skipping that runtime's test.

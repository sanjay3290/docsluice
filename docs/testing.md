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
  Requirements: DOC-2
  Notes: headings from outline levels
  ```

  `Requirements:` lists the PRD requirement IDs the file exercises. `npm run docs:support` turns the tags into [docs/formats/support-matrix.md](formats/support-matrix.md) and fails on a missing or unknown tag; `scripts/test/docs-support.test.mjs` fails when the committed page is out of date.

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

CI runs the unit tests on Node 24. The built package then runs one shared contract (ZIP, XML, and `extract()` on CSV, HTML and hostile HTML) on Node 20, 22 and 24, Bun, Deno, Chromium, Firefox and WebKit (Vitest browser mode), and Cloudflare Workers (local `wrangler dev`). The browser and Workers runs trap any access to `globalThis.Buffer`. [testing-runtime.md](testing-runtime.md) has the command for each runtime. A feature that cannot work in one runtime must say so in its docs page and skip that runtime's test with a reason.

## Bundle budgets and lazy readers (RT-4, RT-5)

`npm run check:package` (part of `npm run verify` and CI) runs `size-limit` with `packages/docsluice/.size-limit.js`. The config reads the reader subpaths from the package's `exports`, so every reader gets a budget as soon as it gets a subpath: Office readers (`doc`, `docx`, `xlsx`, `pptx`) 40 KB and other readers 25 KB, gzipped, plus 50 KB for `docsluice` itself with the text readers it loads lazily. A reader over its budget fails the job.

`packages/docsluice/test-dist/bundle.test.mjs` (in `npm run test:dist`) checks that every reader subpath has a budget, and bundles an app that only does `import { extract } from 'docsluice'` with rolldown: each reader module must end up in its own dynamically imported chunk, never in the app's entry chunk.

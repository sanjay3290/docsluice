# Golden corpus runner

`node scripts/golden-run.mjs` scans the complete `corpus/` tree recursively by default. Use `node scripts/golden-run.mjs --corpus-root corpus/package-a` to scope a local run. Discovery rejects a symlink corpus root and any symlink inside the corpus before filtering metadata. It ignores only the explicit repository metadata names `README`, `README.md`, `.gitkeep`, `.gitattributes`, the `.native.txt` LibreOffice comparison sidecar, plus `.license`, `.expected.json`, `.expected.md`, `.meta.json`, and `.metadata.json` sidecars. Every other regular file is an input; unknown types are not silently filtered.

Every input needs a sibling `<filename>.license` with exactly one non-empty, single-line `SPDX-License-Identifier:` field and exactly one non-empty, single-line `Source:` field. Duplicate identity fields, missing values, and empty values fail validation.

The runner reads input bytes, calls the built public `extract()` API, serializes JSON with `toJSON(doc, { stable: true })`, and renders Markdown with `toMarkdown(doc)`. It compares raw expected-file bytes exactly with the UTF-8 bytes of `<filename>.expected.json` and `<filename>.expected.md`; invalid UTF-8 cannot alias a replacement character. JSON expected files include a final newline; Markdown output is compared as returned. A mismatch reports the sidecar path, first differing byte, and decoded line context. Existing expected-output symlinks are rejected, including when updating, to prevent writes through links.

Build before running the CLI:

```sh
npm run build
node scripts/golden-run.mjs
```

For a local subset, append `--corpus-root corpus/package-a`.

Missing expected files fail with an instruction to review and generate them. To explicitly rewrite expected files locally, run:

```sh
UPDATE_GOLDEN=1 node scripts/golden-run.mjs
```

The runner refuses this mode when `CI` is set. Review every generated diff before accepting it. The isolated behavior tests can run with `node --test scripts/test/golden-run.test.mjs`; they use temporary corpora and injected extraction/rendering functions to test discovery, sidecar validation, exact comparisons, updates, and CI denial. The built-package serializer test runs when `packages/docsluice/dist` is available.

## Current seed corpus and limit

`corpus/package-a/` contains two synthetic, CC0-1.0 samples each for TXT, Markdown, CSV, TSV, JSON, XML, and HTML. Each sample's adjacent `.license` file records the applicable intent requirement IDs. A metadata sidecar is present to exercise discovery exclusion. These files are seeds, not reviewed extraction results.

At this foundation, the public registry has only the legacy DOC reader. The seven text-format readers have not been registered yet, so this seed cannot produce honest extraction goldens. No expected outputs are checked in for these inputs. Once the lead adds the text readers, run the corpus runner, inspect every generated JSON and Markdown diff, and only then add the reviewed snapshots. The temporary-corpus tests do not claim reader behavior.

## CI scope and integration follow-up

The dedicated `Golden tooling` workflow builds the package and runs the runner's isolated tests on Node 24 for pull requests and pushes to `main`. It does not run extraction over the checked-in corpus: the current seed formats still need public readers and reviewed expected snapshots. Once those are available, the lead should add a root `test:golden` alias (or equivalent verification step) that runs `npm run build && node scripts/golden-run.mjs` against the full corpus; that integration is pending and must not be represented as passing today.

Golden refreshes are deferred until every input has extracted and rendered, so extraction or serialization failures do not begin writes. Refresh installation itself is sequential, not transactional: a filesystem error during update can leave some expected files refreshed and a file being written truncated. Review the working tree and rerun the explicit update after resolving such a failure.

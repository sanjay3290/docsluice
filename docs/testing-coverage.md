# Coverage gates

Run the QA-5 line coverage gate from the repository root:

```sh
npm run coverage --workspace docsluice
```

Vitest includes every TypeScript source file under `packages/docsluice/src/`, including files with no tests, so an untested new file enters the denominator at 0% coverage. The gate requires 100% line coverage for `core/budget.ts`, every file under `zip/` and `xml/`; 90% for each reader file; and 85% for every other source file. Per-file checks prevent well-covered files from masking a gap in another file. The global 85% threshold also keeps the combined source coverage from falling below baseline.

The Coverage workflow runs the package coverage command on pull requests and pushes to `main`. Vitest writes a JSON summary and detailed JSON report to `packages/docsluice/coverage/`. The workflow adds overall and module line totals to the job summary and uploads those reports as a short-lived artifact.

The summary script fails when the coverage summary is missing or malformed. Empty module groups are shown as `n/a` until files for that group exist; the matching threshold becomes active automatically when a source file is added.

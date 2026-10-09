# Built package across runtimes

The cross-runtime smoke checks execute the built ESM entry from `packages/docsluice/dist` and use the public ZIP and XML APIs. The shared contract opens a real ODT ZIP and parses its `content.xml`, checks the repository's traversal ZIP, and parses the hostile external-entity XML fixture. Its case module uses web-platform types and APIs only; `run.mjs` contains the small runtime-specific fixture-loading adapter.

Run the portable contract after building the package and installing production dependencies:

```sh
npm ci --ignore-scripts
npm run build --workspace=packages/docsluice
node packages/docsluice/test-runtime/run.mjs
bun run packages/docsluice/test-runtime/run.mjs
deno run --allow-read=. packages/docsluice/test-runtime/run.mjs
```

CI first builds and uploads `dist`, then downloads that same artifact in the Node 20/22/24, Bun, and Deno jobs. Each artifact consumer installs production dependencies with install scripts disabled; this is required because the built ZIP reader imports the declared `fflate` runtime dependency. The workflow also checks that `fflate` resolves from the package workspace before running its runtime contract.

This is incremental QA-4 infrastructure, not full runtime acceptance. The current foundation commit does not contain the `extract()` pipeline or CSV/HTML readers, so this contract does not claim extraction coverage. Browser and Workers simulator jobs remain pending; add them after a dependency-free browser harness and a Workers adapter are available. Keep this suite on the built artifact so the final acceptance jobs can reuse it rather than testing source-only behavior.

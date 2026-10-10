# Built package across runtimes (QA-4, RT-1)

One runtime-neutral contract, `packages/docsluice/test-runtime/cases.mjs`, runs against the built `packages/docsluice/dist` in every runtime. It opens a real ODT ZIP and parses its `content.xml`, checks a path-traversal ZIP and an XXE sample, and runs full `extract()` on a CSV file, an HTML page and a hostile HTML page. Extraction loads each reader through a lazy `import()`, so the runtime's or bundler's dynamic-import support is tested as well.

The inputs are embedded in `test-runtime/fixtures.generated.mjs` (base64 plus SHA-256 of each source), so every runtime reads the same bytes without file access. `node scripts/runtime-fixtures.mjs` regenerates the module from the corpus and hostile sources; `--check` fails on drift and runs in `npm run test:runtime-tools`.

## Run each runtime locally

Build first: `npm ci --ignore-scripts && npm run build`.

| Runtime | Command |
|---------|---------|
| Node 20/22/24 | `node packages/docsluice/test-runtime/run.mjs` |
| Bun | `bun run packages/docsluice/test-runtime/run.mjs` |
| Deno | `deno run --allow-read=. packages/docsluice/test-runtime/run.mjs` |
| Chromium, Firefox, WebKit | `npx playwright install --with-deps chromium firefox webkit`, then `npm run test:browser` |
| Cloudflare Workers | `npm install --prefix /tmp/wrangler --ignore-scripts wrangler@4.146.0`, then `DOCSLUICE_WRANGLER_BIN=/tmp/wrangler/node_modules/.bin/wrangler node scripts/run-workers-runtime.mjs` |

With only a system Chromium available, set `DOCSLUICE_PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome` to run the browser test in that engine alone.

## Browser

`npm run test:browser` uses Vitest browser mode with `@vitest/browser-playwright` (Chromium, Firefox and WebKit), not a DOM emulator. Before the shared cases and the package are imported, the test installs a throwing getter for `globalThis.Buffer`, and keeps it in place through every call. A second test imports a fixture that reads `Buffer` and expects that import to fail, which proves the trap would catch a deliberate `Buffer` use in core.

## Workers

`scripts/run-workers-runtime.mjs` starts `wrangler dev --local` (workerd) on an ephemeral port, sends one request and stops the process group. Wrangler's state, config and cache go to a temporary directory; metrics and Cloudflare credentials are disabled. `wrangler.toml` sets compatibility date `2026-08-03` with no Node compatibility flag, so `Buffer` does not exist in the Worker. The handler installs the same throwing `Buffer` trap before importing the package, and `buffer-trap.test.mjs` checks that a deliberate `Buffer` read fails under it.

Wrangler is not a repository dev dependency. Its `esbuild` and `workerd` dependencies carry install scripts, which ADR 0011 forbids for dev dependencies, so CI installs a pinned copy outside the workspace with scripts off. The prebuilt binaries are resolved from the platform packages.

## CI

The `verify` job builds and uploads `dist`. The Node 20/22/24, Bun, Deno, browser and Workers jobs download that same artifact and install production dependencies with scripts off (the browser job also installs dev dependencies, for Vitest and Playwright).

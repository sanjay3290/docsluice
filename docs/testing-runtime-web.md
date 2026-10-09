# Browser and Workers runtime checks

These adapters run the shared built-package ZIP/XML contract in real browser engines and a local Cloudflare Worker. The shared cases are copied from the reviewed #23 harness and import the package from `packages/docsluice/dist`; they cover a real ODT ZIP and its `content.xml`, a traversal ZIP, and hostile XXE XML. The generated fixture module embeds those source bytes for browser/Worker use, stores SHA-256 hashes, and is checked against the source files so corpus files remain authoritative.

Build the artifact and check fixture drift before running the adapters:

```sh
npm run build
node scripts/runtime-fixtures.mjs --check
```

Vitest Browser Mode uses `@vitest/browser-playwright` with Playwright provider instances for Chromium, Firefox, and WebKit:

```sh
npx playwright install chromium firefox webkit
npx vitest run --config packages/docsluice/test-runtime/browser/vitest.config.mjs
```

If a machine already has a system Chromium, `DOCSLUICE_PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium` runs the same case in that engine only. CI should install Playwright's pinned browser set and use the default three-engine configuration. The browser adapter uses Vitest 5's native browser mode, rather than a DOM emulator; see [Vitest Browser Mode](https://vitest.dev/guide/browser/) and [its Playwright provider](https://vitest.dev/config/browser/playwright).

The Workers check starts Wrangler locally, sends an HTTP request to `127.0.0.1` on an ephemeral port, and tears down the server process group:

```sh
node scripts/run-workers-runtime.mjs
```

The Wrangler config deliberately has no Node compatibility flag and uses compatibility date `2026-08-03`, before the default compatibility behavior introduced for dates on or after `2026-08-04`. This keeps `Buffer` unavailable in the Worker. Before importing the shared cases or the built package, the handler verifies that global `Buffer` is absent and installs a throwing getter trap. The trap remains active while the dynamic imports evaluate and while the real built ZIP/XML paths execute, then is removed in `finally`. A successful HTTP result therefore shows those exercised paths did not touch a Buffer global; a focused regression also imports a fixture that intentionally reads Buffer and verifies that it fails under the trap.

The harness runs `wrangler dev --local`, isolates Wrangler's local config/cache in a uniquely created temporary directory, disables Wrangler metrics, and strips Cloudflare API credential variables. It reports spawn failures directly, terminates and awaits the Wrangler process (including after forced termination), and caps the response body at 64 KiB while cancelling oversized responses. Cloudflare documents both the [compatibility-date behavior](https://developers.cloudflare.com/workers/configuration/compatibility-flags/) and the [local Wrangler command](https://developers.cloudflare.com/workers/wrangler/commands/).

The isolated installation used to validate these adapters pinned `vitest@5.0.3`, `@vitest/browser-playwright@5.0.3`, `playwright@1.64.0`, `vite@8.3.4`, and `wrangler@4.146.0`; the repo already pins Vitest 5.0.3. The provider's exact peer requirement is Vitest 5.0.3 and any Playwright version; it depends on matching `@vitest/browser@5.0.3`. The lead should add the new tools as exact dev dependencies and update the lockfile. This branch intentionally leaves manifests and lockfile untouched. I selected the direct Wrangler adapter because Cloudflare's Workers Vitest plugin injects `nodejs_compat`, which could hide Buffer assumptions; see [Cloudflare's Workers Vitest integration warning](https://developers.cloudflare.com/workers/testing/vitest-integration/isolation-and-concurrency/).

This contract covers the low-level ZIP/XML runtime foundation only. It does not assert CSV/HTML or full `extract()` support; those checks should be expanded after reader registration and review. Chromium passed locally using the available system browser, and the direct Wrangler Worker passed. Playwright's browser downloads returned HTTP 403 from the browser CDN in this environment, so Firefox, WebKit, and the Playwright-managed Chromium binaries could not be run locally. The default config still enumerates all three engines for a machine or CI runner with the browser set installed.

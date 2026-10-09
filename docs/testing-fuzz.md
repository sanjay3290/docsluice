# Fuzz testing

Fuzz targets exercise parsers with both valid seeds and mutated bytes. The harness uses Jazzer.js 4.0.0 under Node 24. Each target runs in its own process so a crash or hang cannot leave the test runner in an unknown state.

## Run a target locally

Install the repository's development dependencies with scripts disabled, then run one target:

```sh
npm ci --ignore-scripts
node scripts/fuzz-run.mjs zip
```

The default run lasts 60 seconds. Use `--seconds 2` for a short smoke run, `--memory-mb 1024` to set the process-tree cap, `--artifacts /path/to/fuzz-artifacts` to choose where reports and crash inputs are written, or repeat `--seed FILE_OR_DIR` to add an input to the copied seed corpus. The default artifact directory is under the operating system's temporary directory. Targets are `zip`, `xml`, `detect`, `detection`, and `ole`.

Jazzer receives a private copy of the seeds. It never modifies the checked-in `corpus/` or `hostile/` files. TypeScript fuzz targets and the source modules they import are compiled to JavaScript under ignored `node_modules/.cache/` before instrumentation so coverage feedback applies to parser code. The library continues to run only on `Uint8Array`; the Node `Buffer` supplied at Jazzer's boundary is passed as a byte view.

The runner treats `DocsluiceError` as an expected result for hostile bytes. Any other exception fails the target. It also checks selected built-in prototypes after each input, gives each input one second, and watches the Jazzer process tree for memory above the configured cap. A watchdog terminates the process group and fails the run. If Linux process-tree sampling fails, the run fails and reports memory monitoring as failed. On non-Linux systems, Jazzer's own timeout and the outer watchdog still apply; RSS monitoring is marked unsupported and peak RSS is reported as unavailable, matching the Linux CI runners.

Seed copying and TypeScript compilation happen before Jazzer starts. `--seconds` and the outer fuzz watchdog cover the Jazzer phase; compilation has its own 30-second hard timeout, kills the compiler process group on timeout, and keeps at most the last 32 KiB of compiler diagnostics. Logs from Jazzer are bounded to the last 512 KiB per stream. The outer watchdog does not include seed copying or preparation time.

## CI runs

`.github/workflows/fuzz-pr.yml` runs every target for 60 seconds on each pull request. `.github/workflows/fuzz-nightly.yml` runs each target for 30 minutes and can also be started manually. Both upload the target artifact directory when a run fails. Crash, timeout, and out-of-memory inputs use a `crash-*` filename; `run.json`, stdout, and stderr record the command, exit status, elapsed time, and observed peak memory.

The repository package manifest and lockfile still need the lead-owned exact `@jazzer.js/core@4.0.0` dev dependency and `fuzz` / `fuzz:test` script aliases before these workflows can run Jazzer. Until that integration lands, direct runner invocations report that Jazzer.js is missing and the fuzz CI jobs are not ready to pass.

## Triage and promote a crash

1. Download the failed target's artifact and replay the input with the target's normal seeds:

   ```sh
   node scripts/fuzz-run.mjs zip --seconds 2 --seed /path/to/crash-input --artifacts /tmp/fuzz-replay
   ```

   Replace `zip` with the failing target. The runner makes a fresh temporary build and corpus copy, then includes the downloaded crash input as a seed.

2. Confirm that the failure is in docsluice rather than in the fuzzer or environment, then minimize the input with Jazzer/libFuzzer's corpus minimization tools.
3. Copy the minimized bytes to `hostile/<format>/<descriptive-name>`. Add a `hostile/manifest.json` row with the observed error or warnings, a time bound, a memory bound, and the relevant PRD requirement. If there is no matching requirement, use the security requirement that describes the violated invariant and explain the case in the test name.
4. Add a regression test that reads the checked-in hostile file and asserts the expected outcome. Run that focused test and `npm test`, then include the seed, test, and manifest entry with the fix.

Do not check a raw crash artifact into `hostile/` until it has been confirmed, minimized, and given a stable expected result. The artifact remains attached to the failed CI run for investigation.

## Add a target

Create `packages/docsluice/fuzz/<name>.fuzz.ts` with a bounded `Uint8Array` entry point. Use the same limits that keep ordinary fuzz inputs fast, and let `DocsluiceError` represent an expected parser outcome. Do not catch arbitrary errors: they are crash signals. Update the `targets` and source-compilation lists in `scripts/fuzz-run.mjs`, add a target mapping and strict invocation path in `packages/docsluice/fuzz/runner/jazzer-target.mjs` (including the expected-error policy), add seed directories in `scripts/fuzz-run.mjs`, and register the name in both workflow matrices. Add a short run or regression test for the new target before merging.

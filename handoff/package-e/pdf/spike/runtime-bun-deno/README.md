# Bun and Deno throwaway PDF runtime probe

This directory holds independent local evidence for issue #44. It changes no
repository code or dependencies. The runner uses only `Uint8Array` data from
fixture files and dynamically imports the exact temporary package entrypoints.
The Bun and Deno binaries and npm packages live under `/tmp/codex-pdf44/`.

Read `runtime-report.md` for outcomes and limitations, `commands.md` for
reproduction, and `sources.sha256` for hashes. JSON files are the raw runner
results. The ordinary Bun runs cover unpdf and legacy PDF.js. Deno legacy
PDF.js uses no network permission. Deno's first unpdf attempt imported a file
URL and failed package self-resolution; the canonical `npm:unpdf@1.7.0`
specifier succeeds offline after the exact package is cached. A separate
successful import-map run is retained as supplemental evidence.

The probes trap `fetch`, `XMLHttpRequest`, global `Worker`, `eval`, and
`Function`; all counters stayed at zero in successful runs. The action fixture
returns its JavaScript marker as data and the marker remains unchanged. Deno
was run without `--allow-net`, `--allow-env`, or write/exec permissions. Bun has
no equivalent per-process network-denial permission here; the global fetch/XHR
traps are API-path observations, not an OS-level network isolation claim.
The runner does not import or call `node:worker_threads.Worker`; only the
standard global `Worker` is trapped.

These five original local inputs establish behavior only for these APIs and
fixtures. One-pass 100-page timings are diagnostic samples, not a benchmark or
the PERF-1 gate. This does not complete #44, establish universal runtime
compatibility, or change the Proposed status of ADR 0009.

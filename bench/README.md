# Reproducible extraction benchmarks

Generate the checked-in fixtures with `node bench/generate.mjs`. The resulting
DOCX, XLSX and PDF files are deterministic; `bench/fixtures/manifest.json` records
their workload sizes, byte lengths and SHA-256 hashes.

Build docsluice and install the pinned comparison tools into a temporary directory:

```sh
npm run build
npm_config_cache=/tmp/bench-npm-cache npm install --prefix /tmp/docsluice-bench-deps --ignore-scripts --no-audit --no-fund --save-exact officeparser@8.1.1 mammoth@1.13.0 xlsx@0.18.5 pdf-parse@2.4.5 unpdf@1.8.1 pdfjs-dist@6.4.299
DOCSLUICE_BENCH_NODE_MODULES=/tmp/docsluice-bench-deps/node_modules node bench/run.mjs
```

The runner uses three fresh child processes per library/input by default. Set
`BENCH_REPEATS` (1–10), `BENCH_TIMEOUT_MS` (1–600000), and `BENCH_MAX_RSS_MIB`
(1–8192; default 1024) to adjust samples and child limits. On Linux, the parent
samples RSS across the isolated process group every 25 ms and kills the group if
the ceiling is exceeded. An unavailable RSS monitor fails closed. It writes the published results page to
`docs/bench/results.md`; pass a path argument to write it elsewhere. Each child must
produce each expected unique marker identity exactly once before its result is marked valid.
An unimplemented docsluice reader is shown as unavailable with no fabricated
duration or memory value. A missing pinned comparator dependency is also shown as
unavailable and makes the command exit nonzero.

`npm run bench` is not registered in the root package manifest in this isolated
change. The package owner can expose it by adding `"bench": "node bench/run.mjs"`
to the root `scripts` map.

See [the methodology and verified comparator notes](../docs/testing-bench.md) and
[the current measurements](../docs/bench/results.md).

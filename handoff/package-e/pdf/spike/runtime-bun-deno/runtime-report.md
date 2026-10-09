# Bun and Deno runtime probe results

**Status:** throwaway API compatibility evidence for #44, not a final engine decision. No repository source, package manifest, lockfile, ADR, or dependency was changed. All tested PDFs are original local synthetic fixtures; this is not malformed-file coverage or reader acceptance.

## Runtime and package provenance

- Bun **1.4.2**, Linux x64, revision `1.4.2+744846f84`; archive SHA-256 `36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913`, matching the asset hash in the upstream-maintained `oven-sh/homebrew-bun` formula. The extracted executable SHA-256 is in `sources.sha256`. The upstream license page identifies Bun as MIT-licensed and lists licenses for statically linked components, including LGPL-2 WebKit/JavaScriptCore components; this is provenance, not a compliance review.
- Deno **2.9.7**, stable, `x86_64-unknown-linux-gnu`; archive SHA-256 `c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490`, matching Deno's checksum file attached to the official release. The extracted executable SHA-256 is in `sources.sha256`. Deno's repository identifies the project as MIT-licensed.
- The candidate was installed as exactly **unpdf 1.7.0** in a separate `/tmp` prefix with npm install scripts disabled; npm's registry integrity was `sha512-MiDhbougTETOvbw/x3hnNr18jzFFrlSitevfO/BHInvtUx68R3Fke9A36GLQfN1LpG1NiJZaV4oPvjioPk9vKQ==`. The package-only install produced no extra runtime package. Its inspected `package.json` (SHA-256 `21b58f4d374e464f647b0c3a5b7a1945e6bafd81d53e4a73f8242a6baf0562ed`) declares MIT. I inspected its bundled `dist/pdfjs.mjs` (SHA-256 `f3f05694d882ecc984f0dd105a1659c45d2f4e2b396649468c067042ef2d231a`); the queried strings `Apache-2.0`, `Apache License`, `apache.org/licenses`, `Mozilla`, and uppercase `NOTICE` were absent. The same file hash is present in the Deno npm cache. This scan does not establish the bundled component's licensing: PDF.js component-license and NOTICE review remains an open question, with no legal conclusion here.
- The comparison package is exactly **pdfjs-dist 5.6.205**, installed in its own `/tmp` prefix with scripts disabled; registry integrity was `sha512-tlUj+2IDa7G1SbvBNN74UHRLJybZDWYom+k6p5KIZl7huBvsA4APi6mKL+zCxd3tLjN5hOOEE9Tv7VdzO88pfg==`. Its package license is Apache-2.0. The reported runtime engine version was 5.6.205 in every successful run.

Primary provenance links:

- [Bun v1.4.2 official release](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2)
- [Upstream Bun formula and archive hash](https://github.com/oven-sh/homebrew-bun/blob/main/Formula/bun.rb)
- [Bun v1.4.2 license and bundled component notices](https://github.com/oven-sh/bun/blob/bun-v1.4.2/LICENSE.md)
- [Deno v2.9.7 official release](https://github.com/denoland/deno/releases/tag/v2.9.7)
- [Deno official v2.9.7 archive checksum](https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip.sha256sum)
- [Deno license](https://github.com/denoland/deno/blob/v2.9.7/LICENSE.md)
- [unpdf 1.7.0 npm metadata](https://registry.npmjs.org/unpdf/1.7.0)
- [pdfjs-dist 5.6.205 npm metadata](https://registry.npmjs.org/pdfjs-dist/5.6.205)

## Results

Each successful run parsed five files using runtime-appropriate file reads and fresh plain `Uint8Array` input. The common configuration was `isEvalSupported:false`, `useWorkerFetch:false`, `useWasm:false`, `disableAutoFetch:true`, `disableStream:true`, `verbosity:0`.

| Runtime / path | Result | PDF.js engine | 100-page sample | Trap counters |
|---|---|---:|---:|---|
| Bun 1.4.2 / unpdf 1.7.0 | 5/5 fixtures parsed | 5.6.205 | 37.78 ms | fetch/XHR/Worker/eval/Function all 0 |
| Bun 1.4.2 / legacy pdfjs-dist | 5/5 fixtures parsed | 5.6.205 | 45.40 ms | all 0 |
| Deno 2.9.7 / unpdf direct file-URL import | **failed before first PDF** | unresolved | n/a | all 0 |
| Deno 2.9.7 / canonical `npm:unpdf@1.7.0` import | 5/5 fixtures parsed | 5.6.205 | 50.94 ms | all 0 |
| Deno 2.9.7 / unpdf with local import-map resolver | 5/5 fixtures parsed | 5.6.205 | 46.15 ms | all 0 |
| Deno 2.9.7 / legacy pdfjs-dist | 5/5 fixtures parsed | 5.6.205 | 41.75 ms | all 0 |

The first Deno attempt imported `dist/index.mjs` directly by file URL. That
does not establish how Deno resolves an npm package's internal self-reference:
it failed with `Import "unpdf/pdfjs" not a dependency`. I then cached the
exact `npm:unpdf@1.7.0` specifier and reran using canonical Deno npm package
resolution (`--node-modules-dir=none`). That path resolved unpdf's own
`unpdf/pdfjs` dynamic import and parsed all five PDFs. Its guarded execution
used `--cached-only`, no `--allow-net`, and no `--allow-scripts`; Deno's help
states that npm lifecycle scripts are only executed when allowed with
`--allow-scripts` (and a node_modules directory), neither of which was used.
The no-network npm-specifier run is the relevant compatibility result. The
separate import-map run also succeeds, but is no longer needed as a workaround
for the canonical package import. The direct-file failure remains a limitation
of that test setup, not evidence that Deno's normal npm package resolution is
incompatible.

The common fixture results matched between successful engines:

| Fixture | Pages | Raw text items | Text chars | Source fact observed |
|---|---:|---:|---:|---|
| `labels-outline-links.pdf` | 3 | 4 | 73 | Labels `i`, `ii`, `A-3`; outline `Synthetic bookmark`; sample first item at x=48, y=740, width≈102.048, height=12, dir `ltr` |
| `two-columns.pdf` | 1 | 8 | 62 | Text items preserve content-stream ordering; layout remains separate work |
| `image-only.pdf` | 1 | 0 | 0 | No OCR attempted |
| `text-100-pages.pdf` | 100 | 100 | 3,000 | First and last page text match the fixture facts |
| `hostile/actions.pdf` | 1 | 1 | 32 | `getJSActions()` returned `this.docsluiceMarker = 1;` as data; marker stayed 0 |

Page `cleanup()` ran once per page and `pdf.destroy()` completed for each
successful fixture. All successful runs reported zero calls to the instrumented
global `fetch`, `XMLHttpRequest`, global `Worker`, `eval`, and `Function`
traps. The runner deliberately did not import or call
`node:worker_threads.Worker`.

## Boundaries and gaps

- Deno was launched with `--no-prompt` and only `--allow-read` for the probe,
  original fixture directory, and installed package trees. No network, env,
  write, subprocess, or run permission was added. Legacy PDF.js emitted a
  nonfatal warning that its optional `@napi-rs/canvas` probe could not read
  `NAPI_RS_NATIVE_LIBRARY_PATH`; it also warned that `Path2D` was unavailable.
  The tested text-only API completed without a render call.
- For canonical Deno npm resolution, dependency metadata/package bytes were
  prefetched to `/tmp/codex-pdf44/deno-cache` with `deno cache` and
  `--node-modules-dir=none`. The guarded run had no `--allow-scripts` and used
  `--cached-only`; thus it could not fetch dependencies or grant lifecycle
  scripts during PDF parsing. The `npm:` cache step did use network access to
  registry metadata and package tarball before the guarded run.
- Bun has no per-process network permission mode in this setup. The global
  fetch and XHR traps observed zero attempts, but attempts through other
  networking APIs were not isolated at the OS layer. Attempts to create a
  network namespace (`unshare -n`) and `bwrap --unshare-net` were rejected by
  the container (`Operation not permitted` / read-only UID map). Do not call
  the Bun result a complete no-network proof.
- A standard global `Worker` trap was installed in both runtimes and recorded
  zero construction attempts. Node's `worker_threads` module was not imported,
  so this is not coverage for a hidden Node-compatible worker binding.
- The 100-page durations are one un-warmed sample per runtime/mode, measured
  around parsing, page text extraction, metadata/action retrieval and cleanup.
  They are diagnostic only, not stable benchmark evidence or a PERF-1 claim.
- This local Linux x64 test does not establish Node 20 support, browser or
  hosted Workers compatibility, production package closure/size, the complete
  action/security matrix, hostile-PDF resilience, or real-corpus accuracy.
  Keep ADR 0009 Proposed pending the rest of #44/#23 and required security,
  licensing, size, and corpus work.

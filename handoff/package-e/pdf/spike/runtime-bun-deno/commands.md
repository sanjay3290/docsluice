# Reproduction and provenance commands

## Downloads and integrity

The Bun v1.4.2 Linux x64 archive came from the official release URL. Its
SHA-256 was compared with the matching hash in the `oven-sh/homebrew-bun`
formula, maintained in the upstream Bun organization. The Deno v2.9.7 archive
was compared with the `.sha256sum` asset from the matching official Deno
release. Both binaries were extracted under `/tmp/codex-pdf44/bin/` only.

```sh
curl -fsSL https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip -o /tmp/codex-pdf44-bun.zip
printf '%s  %s\n' '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913' /tmp/codex-pdf44-bun.zip | sha256sum -c -

curl -fsSL https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip.sha256sum -o /tmp/codex-pdf44-deno.sha256
curl -fsSL https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip -o /tmp/codex-pdf44-deno.zip
sha256sum -c /tmp/codex-pdf44-deno.sha256
```

Bun's formula hash is `36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913` for `bun-linux-x64.zip`; Deno's published checksum file contains
`c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490` for
`deno-x86_64-unknown-linux-gnu.zip`. The actual archive hashes matched both.
The Bun hash is from upstream's maintained formula rather than a separate
checksum file attached to the release.

## Temporary package-only installs

No repository dependency files changed. npm scripts were disabled, and the
npm cache was isolated in `/tmp`.

```sh
npm_config_cache=/tmp/codex-pdf44-npm-cache npm install --prefix /tmp/codex-pdf44/unpdf-only --ignore-scripts --no-audit --no-fund --no-save --save-exact unpdf@1.7.0
npm_config_cache=/tmp/codex-pdf44-npm-cache npm install --prefix /tmp/codex-pdf44/pdfjs-legacy --ignore-scripts --no-audit --no-fund --no-save --save-exact pdfjs-dist@5.6.205
```

`npm view` reported unpdf 1.7.0 integrity
`sha512-MiDhbougTETOvbw/x3hnNr18jzFFrlSitevfO/BHInvtUx68R3Fke9A36GLQfN1LpG1NiJZaV4oPvjioPk9vKQ==`
and pdfjs-dist 5.6.205 integrity
`sha512-tlUj+2IDa7G1SbvBNN74UHRLJybZDWYom+k6p5KIZl7huBvsA4APi6mKL+zCxd3tLjN5hOOEE9Tv7VdzO88pfg==`.
The installed unpdf tree contains only the exact unpdf package (no runtime
dependencies). The comparison pdfjs-dist package installed its declared
optional packages, but text extraction did not call rendering APIs.

## Runtime commands

All fixture reads pass through `probe.mjs` and become fresh plain
`Uint8Array` values. Bun uses `Bun.file(...).bytes()`; Deno uses
`Deno.readFile()`. The Deno commands explicitly grant read access only to this
probe directory, the fixture directory, and temporary installed module trees.
No Deno network permission is granted.

```sh
RUNTIME_DIR=/workspace/package-e-preparation/pdf/spike/runtime-bun-deno
FIXTURES=/workspace/package-e-preparation/pdf-fixtures/generated
UNPDF_URL=file:///tmp/codex-pdf44/unpdf-only/node_modules/unpdf/dist/index.mjs
PDFJS_URL=file:///tmp/codex-pdf44/pdfjs-legacy/node_modules/pdfjs-dist/legacy/build/pdf.mjs
BUN=/tmp/codex-pdf44/bin/bun/bun-linux-x64/bun
DENO=/tmp/codex-pdf44/bin/deno/deno

$BUN "$RUNTIME_DIR/probe.mjs" unpdf "$FIXTURES" "$UNPDF_URL" > "$RUNTIME_DIR/bun-unpdf.json"
$BUN "$RUNTIME_DIR/probe.mjs" legacy "$FIXTURES" "$PDFJS_URL" > "$RUNTIME_DIR/bun-legacy.json"

$DENO run --no-prompt --allow-read="$RUNTIME_DIR,$FIXTURES,/tmp/codex-pdf44/unpdf-only/node_modules,/tmp/codex-pdf44/pdfjs-legacy/node_modules" "$RUNTIME_DIR/probe.mjs" legacy "$FIXTURES" "$PDFJS_URL" > "$RUNTIME_DIR/deno-legacy.json"
$DENO run --no-prompt --allow-read="$RUNTIME_DIR,$FIXTURES,/tmp/codex-pdf44/unpdf-only/node_modules/unpdf" "$RUNTIME_DIR/probe.mjs" unpdf "$FIXTURES" "$UNPDF_URL" > "$RUNTIME_DIR/deno-unpdf.json"
```

The direct-file command above exits 1 with `Import "unpdf/pdfjs" not a
dependency`: importing the file directly does not provide the npm package
self-resolution context. To test Deno's canonical npm package resolution, the
exact version was first cached to a temporary Deno cache. This prefetch step
needs network access; PDF parsing below runs offline:

```sh
DENO_DIR=/tmp/codex-pdf44/deno-cache $DENO cache --no-config --node-modules-dir=none npm:unpdf@1.7.0
DENO_DIR=/tmp/codex-pdf44/deno-cache $DENO run --no-config --node-modules-dir=none --cached-only --no-prompt --allow-read="$RUNTIME_DIR,$FIXTURES" "$RUNTIME_DIR/probe.mjs" unpdf "$FIXTURES" npm:unpdf@1.7.0 > "$RUNTIME_DIR/deno-unpdf-npm.json"
```

The run grants no `--allow-net` and no `--allow-scripts`. Deno CLI help says
npm lifecycle scripts are executed only when allowed by `--allow-scripts` with
a node_modules directory; this run used neither. A second successful run used
the local import map in `deno-import-map.json`:

```sh
$DENO run --no-prompt --import-map="$RUNTIME_DIR/deno-import-map.json" --allow-read="$RUNTIME_DIR,$FIXTURES,/tmp/codex-pdf44/unpdf-only/node_modules" "$RUNTIME_DIR/probe.mjs" unpdf "$FIXTURES" "$UNPDF_URL" > "$RUNTIME_DIR/deno-unpdf-importmap.json"
```

The import map does not download or substitute a package; it points the
unpdf-internal specifier to `dist/pdfjs.mjs` in the same unpdf 1.7.0 install.
It is supplemental evidence; the canonical `npm:` run succeeds without it.
The initial Deno legacy run also exposed an optional-canvas environment access
warning under the intentionally ungranted `--allow-env`; text extraction
still completed. No env permission was added to the recorded runs.

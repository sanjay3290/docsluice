# Local workerd PDF.js runtime probe

**Recorded 2026-10-09.** This is preparation evidence for the PDF engine decision, not a repository implementation, accepted ADR, or completion of issue #23 / A23. The unpdf version and workerd binary below are research-only tools. No dependency was installed into a repository, and generated third-party bundle output is kept under `/tmp`, not this preparation directory.

The probe ran the `unpdf@1.7.0` candidate (bundled PDF.js `5.6.205`) inside the official Cloudflare `workerd` local runtime, package `@cloudflare/workerd-linux-64@1.20261009.1`. It used compatibility date `2026-08-03`, with `nodejs_compat` off and a loopback-only listener. Global outbound is explicitly assigned to a local `Network` service named `deny-outbound` configured with `allow = []` (and `deny = []`); the service has no egress-allowing bindings. The config SHA-256 is `38daacf73a4af36e9f692b5aaed3a9f52ef8141f4916bc5cae19f96c1a87af53`. The initial config template omitted `globalOutbound`; the official schema shows its default is `"internet"`, so that first version did not establish a no-network configuration. The template and probe were corrected and rerun with the explicit deny-all service. The npm package was fetched with `npm pack --ignore-scripts`; its inspected manifest declared no install scripts. Package SHA-256: `dc12f112b875dae080cf88570f242175d98d8d5be4eca315a8ecdb15587ab8e0`; extracted binary SHA-256: `7a3e70a6c75fa2200532d1cbe87bd08c523cd297738f4de381f61b03c26b83b3`. It is Apache-2.0 and about 135 MB unpacked, so it is a local test tool rather than an application dependency.

The original synthetic PDF fixtures under `pdf-fixtures/generated/` were embedded as base64 bytes in the generated worker module. The exercised API settings were `isEvalSupported:false`, `useWasm:false`, `useWorkerFetch:false`, `disableAutoFetch:true`, `disableStream:true`, and `disableRange:true`. The worker read fixture bytes only; it did not use browser file, URL, or viewer APIs. The result records labels, outline titles, metadata projection, annotation links, JavaScript actions as data, text-item positions, and a 100-page case.

Five cases matched authored source facts: labels/outline/link/position/metadata; two-column text-item positioning; image-only zero text items; an OpenAction string returned as data without executing its marker; and 100 pages with 100 items and 3,000 characters. Global `fetch`, XHR, `Worker`, `eval`, and `Function` apply/construction guards were installed after static imports; every counter remained zero. The worker observed no global `Buffer`. The metadata-disabled result is a probe-side projection check, not an unpdf option. The two-column result confirms positioned items are returned, but does not establish reading-order accuracy. Timings in the raw JSON are observations from one run only and are not performance claims.

Instrumentation has limits: guards run after module imports, so they do not cover bundle initialization; global API interception is not proof that all runtime internals or every future code path are incapable of network or dynamic-code use. Local workerd evidence also cannot establish hosted Workers behavior or security. Cloudflare’s own README warns that workerd is “not a hardened sandbox.” The workerd probe made no external requests and used no hosted deployment or secrets; setup fetched the documented npm tools. Full acceptance still needs the frozen-baseline harness, target matrix, and lead review.

## Reproduction outline

Prerequisites are the existing `/workspace/docsluice-package-e/node_modules/.bin/tsdown`, the research-only unpdf installation at `/tmp/docsluice-unpdf-only/node_modules/unpdf`, the fixture directory above, and the exact workerd npm package version. Commands below create all generated code and binaries in `/tmp`.

```sh
mkdir -p /tmp/docsluice-workerd-tools/{src,bundle,unpack}
cd /tmp/docsluice-workerd-tools
npm pack @cloudflare/workerd-linux-64@1.20261009.1 --ignore-scripts
tar -xzf cloudflare-workerd-linux-64-1.20261009.1.tgz -C unpack
ln -s /tmp/docsluice-unpdf-only/node_modules/unpdf node_modules/unpdf
node /workspace/package-e-preparation/pdf/spike/runtime-workers/generate-worker-input.mjs
/workspace/docsluice-package-e/node_modules/.bin/tsdown \
  /tmp/docsluice-workerd-tools/src/worker-entry.mjs \
  --no-config --format esm --platform neutral --target es2022 --minify \
  --out-dir /tmp/docsluice-workerd-tools/bundle --clean
```

Copy `workerd-config-template.capnp` into `/tmp/docsluice-workerd-tools/workerd.capnp`. Replace the embedded PDF.js chunk filename with the filename emitted in the bundle directory if it differs. Start the local runtime from that directory:

```sh
cd /tmp/docsluice-workerd-tools
./unpack/package/bin/workerd serve workerd.capnp
```

In another shell, save the loopback response as the evidence JSON and validate its authored source facts:

```sh
curl --fail http://127.0.0.1:18897/probe \
  -o /workspace/package-e-preparation/pdf/spike/runtime-workers/workerd-result.json
node /workspace/package-e-preparation/pdf/spike/runtime-workers/verify-results.mjs \
  /workspace/package-e-preparation/pdf/spike/runtime-workers/workerd-result.json
```

The result validator reports `expected-source-facts-match` only if fixture facts, zero guard counters, and the expected runtime settings agree. It does not claim standards-wide parser correctness or package acceptance.

## Primary references

- [Cloudflare workerd README](https://github.com/cloudflare/workerd/blob/main/README.md) — local runtime role, configuration model, npm platform packages, and sandbox caveat.
- [Cloudflare workerd configuration schema](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp) and [official hello-wasm sample configuration](https://github.com/cloudflare/workerd/blob/main/samples/hello-wasm/config.capnp) — worker modules, services, sockets, compatibility date, and the default `globalOutbound = "internet"` plus explicit override semantics.
- [Official npm package metadata](https://registry.npmjs.org/@cloudflare%2fworkerd-linux-64/1.20261009.1) — version, package integrity and distribution metadata.

Detailed hashes, measured output, and instrumentation status are in `runtime-metadata.json` and `workerd-result.json`.

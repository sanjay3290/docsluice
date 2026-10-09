# Temporary runtime tool paths

Recorded 2026-10-09. This lookup records where the local probe used its tools; it does not install or authorize any repository dependency.

| Purpose | Path | Version / evidence |
| --- | --- | --- |
| Workerd binary | `/tmp/docsluice-workerd-tools/unpack/package/bin/workerd` | `@cloudflare/workerd-linux-64@1.20261009.1`; version output `workerd 2026-10-09`; package and binary SHA-256 in `runtime-metadata.json` |
| unpdf research install | `/tmp/docsluice-unpdf-only/node_modules/unpdf` | `unpdf@1.7.0`, research-only; runtime-reported bundled PDF.js `5.6.205` |
| Bundler | `/workspace/docsluice-package-e/node_modules/.bin/tsdown` | tsdown `0.23.0`, Rolldown `1.2.13`; tool already present, not modified |
| Generated entry, base64 fixture payloads | `/tmp/docsluice-workerd-tools/src/worker-entry.mjs` | Generated from `worker-template.mjs` and authored fixtures |
| Bundled ESM modules | `/tmp/docsluice-workerd-tools/bundle/` | 53,524-byte entry and 1,609,661-byte PDF.js chunk; hashes in `runtime-metadata.json` |
| Local runtime configuration | `/tmp/docsluice-workerd-tools/workerd.capnp` | Derived from `workerd-config-template.capnp`; loopback-only listener and explicit deny-all global outbound; SHA-256 in `runtime-metadata.json` |
| Captured response before copying to preparation | `/tmp/docsluice-workerd-tools/result.json` | Same probe output as `workerd-result.json` |

The preparation folder contains the template, generation/validation scripts, configuration template, result JSON, metadata, and instructions. It does not contain the workerd binary, npm tarball, generated embedded fixture module, or bundled third-party JavaScript.

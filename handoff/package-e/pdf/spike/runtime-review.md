# Independent #44 runtime probe review

Date: 2026-10-09  
Scope: review of /workspace/package-e-preparation/pdf/spike/runtime-bun-deno/ and /workspace/package-e-preparation/pdf/spike/runtime-workers/; no repository or third-party bundle changes were made.

## Result

The corrected local runtime evidence is internally consistent for the stated synthetic fixtures. I independently reran the Bun and Deno probes, the canonical cached Deno npm import, and the pinned local workerd service; source-fact validators and recorded hashes passed. The earlier workerd config did not disable outbound fetch, but the probe author corrected it before this review completed. The corrected config explicitly points globalOutbound to a named network service with empty allow/deny lists.

This is still narrow local compatibility evidence, not #44 acceptance, hosted Workers certification, a security proof for all code paths, or real-PDF accuracy evidence.

## Fresh validation

- sha256sum -c runtime-bun-deno/sources.sha256: all listed package, runtime, fixture, runner, result, and Deno-cache hashes matched.
- Re-ran Bun 1.4.2 with unpdf 1.7.0 and legacy pdfjs-dist 5.6.205: each parsed 5/5 fixtures; observed trap counters were zero and the action marker stayed 0.
- Re-ran Deno 2.9.7 with legacy pdfjs-dist and with canonical npm:unpdf@1.7.0, using --cached-only, no --allow-net, and no --allow-scripts: each parsed 5/5 fixtures; counters were zero and the action marker stayed 0.
- Re-ran the direct-file Deno unpdf path: it still fails before parsing with Import "unpdf/pdfjs" not a dependency. This is a file-URL/package-self-resolution context issue, not evidence against normal npm resolution; the canonical npm: path succeeds without the import map. The separate import-map success is supplemental.
- Ran the corrected workerd result validator and made a fresh loopback request to the pinned local workerd binary. Expected source facts passed; the result reports globalOutbound: "deny-outbound", nodejsCompatEnabled: false, bufferGlobalAvailable: false, zero guard counters, and unchanged marker. The config and bundle hashes match the updated metadata.

## Findings and limits

### Workerd outbound policy was corrected

The initial workerd config omitted globalOutbound, which would have inherited workerd's "internet" default. The author corrected this to globalOutbound = "deny-outbound" and added a named Network service with allow = []. The updated config hash is 38daacf73a4af36e9f692b5aaed3a9f52ef8141f4916bc5cae19f96c1a87af53; the new template, metadata, README, and result agree. This matches the official [workerd config schema](https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp), which documents both the default internet service and the per-worker globalOutbound override. No outbound request was made to test denial; the current evidence is configuration-backed plus a successful local runtime parse.

### Instrumentation scope is described accurately

Bun and Deno install global fetch/XHR/Worker/eval/Function guards before dynamically importing the PDF engine. Deno's canonical npm prefetch used network access to the registry, but the subsequent PDF run is cached-only and has no network permission. Bun has no OS-level network isolation in this container; its report correctly limits the result to intercepted global API calls. The worker template uses static imports, so workerd guard installation occurs after bundle initialization; both its result and README explicitly state that limitation. The standard global Worker is trapped, but node:worker_threads.Worker is not imported or tested, as documented.

### No-Node and no-Buffer wording is supported within scope

The workerd template has no nodejs_compat configuration, and the runtime result observes no global Buffer. I inspected the hashed bundle: it contains no node: import specifiers. It does contain guarded process and Buffer feature-detection references, so the evidence supports “no Node compatibility enabled / no Buffer global / no Node built-in imports,” not a broader claim that dependency source contains no Node-related identifiers. Parsing succeeds in the configured worker without those compatibility globals.

### Cleanup is enforced by control flow, not counters

The Bun/Deno runner awaits page.cleanup() in the page loop and awaits pdf.destroy() in a finally block. Its successful result is emitted only after destruction resolves, although pageCleanupCalls and documentDestroyed are reported as expected values rather than instrumented counters. The workerd runner also awaits pdf.destroy() in finally; it does not claim per-page cleanup counts. No cleanup failure appeared in fresh runs.

### One wording clarification would make provenance clearer

The workerd README says “No hosted deployment, secrets, or external network were used,” while its setup instructions also document fetching the runtime npm package. The runtime worker itself is configured with deny-all outbound, and no external request was made by the worker; consider changing that sentence to say “The workerd probe made no external network requests” so it cannot be read as a claim about package setup.

## Boundaries retained

All cases are original synthetic inputs. The two-column probe confirms positioned text items are available, not that reading order is correct. One-pass 100-page timings are diagnostic only. These runs do not establish malformed-PDF resilience, real-corpus accuracy, browser/Node/hosted Workers coverage, or overall engine licensing, size, and security acceptance. ADR 0009 remains Proposed pending the other #44/#23 work.

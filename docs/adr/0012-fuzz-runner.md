# ADR 0012: Jazzer.js fuzz runner

**Status:** Accepted  
**Date:** 2026-10-09

## Context

QA-6 requires coverage-guided fuzzing for parser inputs on pull requests and nightly. A fuzzer must support the repository's Node 24 development runtime, native ESM targets, the existing TypeScript source, bounded execution, seed corpora, and crash artifacts. Dependency install scripts remain disabled by repository policy.

## Decision

Use `@jazzer.js/core` at exact version `4.0.0` as a development-only dependency. Its CLI accepts native ESM targets exporting `fuzz`, supports libFuzzer time and artifact flags, and works on Node 24. The package metadata has no install lifecycle scripts; an isolated `npm install --ignore-scripts --no-save --no-package-lock @jazzer.js/core@4.0.0` completed successfully. The local proof also showed a seeded exception creates a crash artifact, and a two-second XML run produced coverage feedback over compiled parser source.

The wrapper runs one target per process, copies source seeds into a temporary corpus, compiles TypeScript targets and parser sources to ignored `node_modules/.cache/`, then invokes Jazzer with source instrumentation. Each target has a 60-second PR budget or a 30-minute nightly budget, a one-second per-input timeout, a 1 GiB Linux process-tree memory cap, and a hard outer watchdog. `DocsluiceError` exceptions are expected; unexpected exceptions, timeout, memory excess, or mutation of selected built-in prototypes fail the run. ZIP has a strict harness adapter because its existing target intentionally catches all exceptions for unit-fuzz convenience.

## Consequences

- The fuzzer and compiler are development tools only; no public export or runtime dependency changes.
- Linux x64 CI is the supported initial host for process-tree RSS monitoring. Other hosts retain the per-input timeout and outer watchdog.
- Jazzer/libFuzzer seed discoveries are run-local. Confirmed failures are promoted to `hostile/`, paired with a manifest row and regression test, then minimized before check-in.
- New readers need a bounded target, source/seed registration, workflow matrix registration, and a regression test.
- The exact dev dependency and root `npm run fuzz` alias must be wired by the integration owner; the implementation remains limited to assigned fuzz infrastructure paths.

## Alternatives

- A standalone mutational runner was rejected because it would not provide the coverage guidance QA-6 asks for.
- `@jazzer.js/jest-runner` was rejected; the direct CLI avoids coupling the library's parser tests to Jest and supports a simple per-target process boundary.

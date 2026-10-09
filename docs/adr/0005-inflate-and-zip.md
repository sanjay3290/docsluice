# 0005. Own zip reader on fflate's pure-JS inflate

- Status: Accepted
- Date: 2026-10-09
- Requirement IDs: SEC-1, SEC-2, SEC-3, NST-1, RT-2, PRD Q5

## Context

`DecompressionStream` exists in most runtimes but not all, and it gives no control over output size while it runs. SEC-1 needs a byte count during decompression, so a bomb stops before it fills memory. Existing zip libraries (adm-zip, yauzl) trust header sizes, are Node-only, or have advisories.

## Decision

- Use **fflate** (`fflate`, MIT, no dependencies) streaming `Inflate` for every runtime, for the same results everywhere.
- Write our own zip reader in `src/zip/`: parse the end-of-central-directory record and the central directory, check the entry-count limit before reading entries, and inflate one entry at a time through the budget. Never trust sizes written in headers.
- gzip (P1) uses the same inflate path.

## Consequences

- One runtime dependency (fflate). It must stay pinned and reviewed on update.
- The zip module needs 100% line coverage (QA-5).

# 0013. Defer default-limit changes until reader performance is measurable

- Status: Proposed — no limit changes
- Date: 2026-10-09
- Requirement IDs: PERF-1, PERF-2, PERF-3

## Context

The generated benchmark inputs and adapters can measure the named comparison
libraries, but the accepted docsluice base only implements the legacy DOC reader.
The PERF-1 workloads (5 MiB DOCX, 50,000-row XLSX, and 100-page text PDF) therefore
return `UNSUPPORTED_FORMAT` from docsluice. A time from detection, ZIP inspection,
or a different library is not evidence for the performance of an unimplemented
docsluice reader. The benchmark records sampled process-group RSS including the
Node runtime and uses a process ceiling, but this is not parser-only allocation
or an incremental parser memory bound.

## Decision

Do not change `DEFAULT_LIMITS` using these measurements. Keep current defaults as
starting values until DOCX (#29), XLSX (#34), and PDF (#46) can produce and validate
their complete semantic outputs under the benchmark. Then measure `inputBytes`,
`totalUncompressedBytes`, `cells`, `outputChars`, `pdfPages`, and `timeMs` workloads
on the same documented benchmark machine, and propose only limit changes supported
by those results.

## Consequences

- PERF-1 remains unverified for docsluice; the results page says so explicitly.
- Comparator timings remain useful for reproducibility and adapter checks, but they
  do not count as a docsluice target pass.
- No runtime options or security defaults change in this issue.
- This ADR should be superseded with measured evidence after the blocked readers
  land; do not infer a default from the current sample.

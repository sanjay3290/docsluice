# Independent review: final #82 PDF table delta

**Scope:** read-only review of the final private table staging helper in `/workspace/docsluice-package-e-82`, focused on the shared-budget contract changes. I did not edit source or tests. This helper still consumes synthetic/pre-positioned layout lines and is not a registered PDF reader or extraction-accuracy result.

## Verification

Ran from `packages/docsluice`:

```sh
node ../../node_modules/vitest/vitest.mjs run test/readers/pdf/tables/tables.test.ts
```

Result: **1 test file, 18 tests passed** (exit code 0).

## Delta review

- **Prior resource truncation is handled separately from depth limitation.** `stageTables` returns early when the shared warnings contain `TRUNCATED`, while allowing a usable parent budget to proceed after `DEPTH_LIMIT`. This matches `Budget.canRead`, which is depth-based, and avoids treating the parent's depth warning as a reason to discard the parent's own page. Tests cover byte/output truncation and a depth-limited parent with both ruled success and aligned fallback.
- **Nested source-index work checks the shared budget.** `validLines` ticks while copying and deduplicating each line's indices; cell construction and both ruled/aligned aggregation paths also tick while collecting source indices. The global 200,000-index cap and 1,000-per-line cap bound those loops. Comparator/sort work also ticks.
- **Precharged counters are included without double charging.** The new regression starts with six of ten cells and ten of 100 output characters charged, stages a four-cell candidate, and asserts both counters remain at their precharged values. This demonstrates the staged plan fits the remaining budget and leaves emission charges to the builder.
- **Configured limit and cancellation behavior remains visible.** Tests retain strict cell-limit propagation, abort propagation, staged output rejection, and the oversized input-array guard. No catch swallows `AbortError` or `LimitExceededError` in the staging paths reviewed.

## Follow-up contract edge

One conservative edge is not covered by the tests: `buildGrid` preflights the count of all complete individual cells before `ranges` discards connected components that are too small to qualify as tables. A page with four spatially separated, fully bordered 1x1 cells can therefore trigger the cell-limit warning (or strict-mode exception) even though `ranges` returns no table candidate. The fixed 65,536-cell grid cap already bounds the occupancy allocation. If `cells` is intended to bound only staged/output cells, consider deriving the preflight count from qualifying rectangular ranges; if it intentionally also bounds complete ruled-cell analysis, document and test that conservative behavior. This is a resource-policy clarification, not a failure of the requested delta.

The requested delta itself has no blocker found. These results establish synthetic helper behavior only; real PDF operator mapping, adapter integration, source-index fidelity against the engine, and reviewed extraction goldens remain unverified.

# Independent #46 PDF layout review

**Scope:** read-only review of `packages/docsluice/src/readers/pdf/layout/layout.ts`, its focused test, and `docs/formats/pdf-layout.md`. This is a helper review only; private adapter #45, representative goldens/corpus #27, and the 10-page accuracy gate remain unavailable, so it is not an acceptance or end-to-end accuracy claim.

## Verification

Ran from `packages/docsluice`:

```sh
node ../../node_modules/vitest/vitest.mjs run test/readers/pdf/layout/layout.test.ts
```

Result: 1 file, 21 tests passed. The pnpm-filter wrapper could not run in this environment because it attempted a dependency install and failed creating `/home/agent/.local/share/pnpm`; direct Vitest used the already-present workspace dependency and passed.

## Findings

- **Budget staging is coherent.** `Budget.checkOutputChars(amount)` validates a nonnegative safe integer and checks `outputChars + amount` against the shared limit without incrementing the counter. The helper reserves one staged character per accepted item, keeps a surrogate-safe prefix after the first failed check, and leaves actual output charging to the eventual builder. The test proves an existing counter of four is included and the counter stays four. The conservative `+1` reservation may trim one character even where the eventual serialization would need no separator; this is safe but should remain understood as a heuristic.
- **One integration edge to verify:** `checkOutputChars` does not itself stop because `budget.truncated` is already true. The helper also never checks that property, so if an earlier operation has marked the shared budget truncated while output capacity remains, this routine can continue sorting/laying out the supplied page. That follows `Budget` semantics (truncation is a signal/warning, not an automatic global read gate), but the adapter/caller should stop invoking layout after prior truncation, or the helper should explicitly short-circuit if the intended contract is “no more work after any truncation.” Test this on the adapter path before acceptance.
- **Bounded complexity and cancellation:** per-item normalization, geometry scans, sorts, line/column passes, and paragraph creation call `budget.tick()`; therefore abort checks are frequent and sort comparisons incur periodic clock checks. The tests cover immediate abort but not abort during a large sort or a low-time budget on a large synthetic input. Add one stress test around the chosen item cap/timeout when a concrete cap is settled; do not claim asymptotic behavior beyond the implementation's sort/sweep structure.
- **Hand-authored expected cases:** two/three columns, zone separators, footnote tail, spacing, superscript, paragraph split/dehyphenation, RTL source order, tie stability, and all four page rotations have concrete expected data. The 90/180/270 expected boxes are consistent with the stated bottom-left-to-top-left conversion followed by clockwise rotation. These cases validate deterministic mechanics, not PDF-engine reading order. The docs correctly caveat corpus accuracy.
- **Invalid geometry:** NaN/oversized font/coordinate, malformed transform, empty page, unsupported runtime rotation, and an accepted normal item are tested. Runtime `dir` is not validated: anything other than `'rtl'` is silently treated as `'ltr'`. PDF.js can emit `dir: 'ttb'`; either explicitly skip/flag unsupported vertical items or make this limitation part of the adapter contract. Current docs say vertical writing can remain ambiguous, which is honest, but silently treating it as LTR could scramble text.
- **Whitespace:** tests cover inserted gaps and explicit interior spaces, and line `.trim()` intentionally strips edge whitespace. There is no test for a source item containing embedded newline/CR or tabs; these characters are otherwise preserved into a nominal single line. Decide and test the adapter’s normalization contract for line separators/control whitespace before wiring real PDF.js items.

## Suggested next checks

1. Add an adapter-level test showing layout is not called after an earlier shared-budget truncation, or make the helper honor `budget.truncated` if that is the intended local contract.
2. Add a vertical `dir: 'ttb'` case and define skip/warning behavior rather than silently labeling it LTR.
3. Add one large-item timeout/abort stress test and one source-whitespace normalization case when #45 supplies the real item shape.
4. Keep #27 human-reviewed real-page goldens and #46's 10-page acceptance accuracy gate outstanding. None of the synthetic tests can substitute for those.

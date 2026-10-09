# Independent review: final #46 PDF layout delta

**Scope:** read-only review of the final private layout helper and its focused tests in `/workspace/docsluice-package-e-46`, specifically the changes since `pdf-final-review.md`. No source files were changed. This is synthetic helper evidence only; the PDF.js adapter, real-PDF goldens, and the ten-page accuracy gate remain outstanding.

## Verification

Ran from `packages/docsluice`:

```sh
node ../../node_modules/vitest/vitest.mjs run test/readers/pdf/layout/layout.test.ts
```

Result: **1 test file, 27 tests passed** (exit code 0).

## Delta findings

- **The silent unsupported-direction drop is now observable to the adapter.** `LayoutResult.unsupportedDirectionItems` counts runtime items whose direction is not `ltr` or `rtl`; the mixed `ttb`/horizontal regression asserts the horizontal text remains and the count is one. The layout documentation says the adapter must emit a static, content-free warning when the count is nonzero. This addresses the prior helper-level review concern. The warning itself is still an adapter responsibility, so it is not verified until #45 consumes this result field.
- **The missing timeout and cancellation stress cases are covered.** A 5,000-item all-empty scan uses a deterministic `performance.now()` stub to prove the time budget stops scanning; a separate 1,000-item all-empty scan aborts at a deterministic tick and asserts `AbortError`. Both prevent empty text from bypassing time/cancellation checks.
- **The precharged-counter case now proves a fitting staged result succeeds.** With four output characters already charged and a limit of twelve, the helper stages `hello x`, leaves the truncation state false, and leaves the shared `outputChars` counter at four. This complements the prior over-limit/prefix test and confirms staging does not charge or double-count output.

No new correctness or security issue was found in these requested deltas. The result field is a count only, not a warning; callers must use it and must continue to honor shared budget/cancellation behavior. The broader prior-review items about real-engine behavior, corpus accuracy, and adapter-level integration remain open and are outside this delta review.

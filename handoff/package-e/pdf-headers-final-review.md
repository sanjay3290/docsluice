# Independent PDF header/footer helper review

Date: 2026-10-09  
Reviewed commit: `86d96df2316b2dcb65aa52718c3eb3be09607ba0` in `/workspace/docsluice-package-e-48`  
Scope: read-only review of `packages/docsluice/src/readers/pdf/headers/index.ts`, its 19 focused tests, and the module documentation. No repository source or test files were changed.

## Result

No correctness or safety blocker found in the private helper. The code implements all-page quorum for headers and footers, and the alternating parity exception only for headers. Classification stages references and bounded normalized text without charging output characters; a limit failure returns the original page lines with no groups.

## Checks

- Ran `npx vitest run packages/docsluice/test/readers/pdf/headers/headers.test.ts`: **19 tests passed**.
- Reviewed preflight placement: `candidateFor` checks shared prior output plus unique staged normalized text and source line length before calling `normalizeLineText` (NFC conversion and parts join). A new group's normalized key is separately preflighted before it is retained.
- Reviewed limit behavior: if a check truncates, detection stops and returns all input lines unchanged with empty groups; prior resource truncation and unavailable child-depth views also bypass classification. Staged text is never added to `Budget.outputChars`; tests verify both noncharging and accounting for already-charged output.
- Reviewed quorum semantics: source page indices are deduplicated for document/parity counts and per-group matches; comparisons use integer arithmetic for the 60% threshold and require at least three pages. Footers cannot use the parity exception.
- Reviewed deterministic behavior: normalized positions are rounded to three decimal places before bucket matching; group and page index output has explicit sorting; candidate ties use input order; tests verify stable group order and no mutation of source lines.
- Confirmed coverage tests exercise 3/5 whole-document threshold, odd/even header variants, footer rejection below whole-document quorum, prior truncation, oversized candidates, and a nonzero shared output counter.

## Remaining test gap

The parity test uses all three pages in each cohort of a six-page document. There is no direct parity boundary test where exactly three of five pages in one cohort qualify, nor one just below that threshold. This is a useful follow-up for threshold-edge completeness, but the integer comparison in `qualifies` is correct on inspection and no behavior defect was observed. Likewise, the tests do not pin candidate position values exactly at the 10% band boundary or the tolerance boundary; existing tests cover interior top/bottom candidates and stable classification.

This remains private helper preparation: tests are synthetic `LayoutLine` inputs and do not demonstrate #46 adapter integration or real-PDF accuracy.
